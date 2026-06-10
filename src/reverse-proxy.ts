import * as https from "https";
import * as http from "http";
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "http";
import * as fs from "fs";
import * as path from "path";
import * as zlib from "zlib";
import { spawn } from "child_process";
import { traceDebug, traceRuntimeError } from "./cli-common";
import { HTMLGenerator } from "./html-generator";
import { SharedConversationProcessor } from "./shared-conversation-processor";
import {
	buildOpenAIChatCompletionFromSSE,
	buildOpenAIResponsesFromSSE,
	parseOpenAIChatCompletionBody,
	parseOpenAIResponsesBody,
} from "./openai-adapter";
import { inferApiFormatFromUrl } from "./api-format";
import { normalizeUpstreamPath, resolveModelRoute, inferApiFormatFromPath } from "./proxy-routing";
import type { RawPair, SSEEvent } from "./types";
import type { ApiFormat, ModelRoute } from "./tools/types";
import type { Message } from "@anthropic-ai/sdk/resources/messages";

export interface ReverseProxyConfig {
	port?: number;
	logDirectory?: string;
	logBaseName?: string;
	includeAllRequests?: boolean;
	openBrowser?: boolean;
	logSensitiveHeaders?: boolean;
	targetBaseUrl?: string;
	routes?: Record<string, string>;
	modelRoutes?: Record<string, ModelRoute>;
	tool?: string;
}

export interface ProxyInfo {
	port: number;
	url: string;
}

interface ParsedTarget {
	protocol: string;
	targetHost: string;
	targetPort: number;
	pathPrefix: string;
}

function parseTargetBaseUrl(targetBaseUrl?: string): ParsedTarget {
	const parsed = new URL(targetBaseUrl || "https://api.anthropic.com");
	const pathPrefix = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/$/, "");
	return {
		protocol: parsed.protocol,
		targetHost: parsed.hostname,
		targetPort: parsed.port
			? parseInt(parsed.port, 10)
			: parsed.protocol === "https:" ? 443 : 80,
		pathPrefix,
	};
}

const LLM_API_PATHS = [
	"/v1/messages",
	"/messages",
	"/v1/chat/completions",
	"/chat/completions",
	"/v1/responses",
];

function isLlmApiPath(urlPath: string | undefined): boolean {
	if (!urlPath) {
		return false;
	}
	return LLM_API_PATHS.some((segment) => urlPath.includes(segment));
}

function resolveRouteTarget(
	reqUrl: string | undefined,
	routes: Record<string, string> | undefined,
	fallback: ParsedTarget,
): ParsedTarget & { upstreamDisplayPath: string } {
	if (!reqUrl || !routes || Object.keys(routes).length === 0) {
		const upstreamDisplayPath = `${fallback.pathPrefix}${reqUrl || "/"}`;
		return { ...fallback, upstreamDisplayPath };
	}

	const match = reqUrl.match(/^\/p\/([^/]+)(\/.*)?$/);
	if (!match) {
		const upstreamDisplayPath = `${fallback.pathPrefix}${reqUrl}`;
		return { ...fallback, upstreamDisplayPath };
	}

	const providerId = decodeURIComponent(match[1]);
	const remainder = match[2] || "/";
	const upstreamBaseUrl = routes[providerId];

	if (!upstreamBaseUrl) {
		const upstreamDisplayPath = `${fallback.pathPrefix}${reqUrl}`;
		return { ...fallback, upstreamDisplayPath };
	}

	const target = parseTargetBaseUrl(upstreamBaseUrl);
	const upstreamDisplayPath = `${target.pathPrefix}${remainder}`;
	return {
		...target,
		upstreamDisplayPath,
	};
}

function extractModelFromBody(requestBody: string): string | null {
	if (!requestBody) {
		return null;
	}

	try {
		const parsed = JSON.parse(requestBody) as { model?: unknown };
		return typeof parsed.model === "string" ? parsed.model : null;
	} catch {
		return null;
	}
}

function resolveModelTarget(
	reqUrl: string | undefined,
	requestBody: string,
	modelRoutes: Record<string, ModelRoute>,
	fallback: ParsedTarget,
): (ParsedTarget & { upstreamDisplayPath: string; modelRoute?: ModelRoute }) | null {
	const model = extractModelFromBody(requestBody);
	if (!model) {
		return null;
	}

	const modelRoute = resolveModelRoute(model, modelRoutes);
	if (!modelRoute) {
		traceDebug(`opencode-trace: unknown model "${model}", cannot route request`);
		return null;
	}

	const target = parseTargetBaseUrl(modelRoute.upstreamBaseUrl);
	const [rawPath, query = ""] = (reqUrl || "/").split("?");
	const urlPath = normalizeUpstreamPath(rawPath, modelRoute, target.pathPrefix);
	const upstreamDisplayPath = `${target.pathPrefix}${urlPath}${query ? `?${query}` : ""}`;

	traceDebug(
		`opencode-trace: ${reqUrl || "/"} | model=${model} → provider=${modelRoute.providerId} (${modelRoute.apiFormat}) → ${modelRoute.upstreamBaseUrl}`,
	);

	return {
		...target,
		upstreamDisplayPath,
		modelRoute,
	};
}

export class ReverseProxyServer {
	private server: http.Server | null = null;
	private pairs: RawPair[] = [];
	private stopped = false;
	private readonly targetProtocol: string;
	private readonly targetHost: string;
	private readonly targetPort: number;
	private readonly pathPrefix: string;
	private readonly useHttps: boolean;
	private readonly config: Required<
		Pick<
			ReverseProxyConfig,
			| "port"
			| "logDirectory"
			| "logBaseName"
			| "includeAllRequests"
			| "openBrowser"
			| "logSensitiveHeaders"
		>
	>;
	private readonly logFile: string;
	private readonly jsonFile: string;
	private readonly htmlFile: string;
	private readonly htmlGenerator: HTMLGenerator;
	private readonly tool?: string;
	private readonly routes?: Record<string, string>;
	private readonly modelRoutes?: Record<string, ModelRoute>;

	constructor(config: ReverseProxyConfig = {}) {
		const target = parseTargetBaseUrl(config.targetBaseUrl);
		this.targetProtocol = target.protocol;
		this.targetHost = target.targetHost;
		this.targetPort = target.targetPort;
		this.pathPrefix = target.pathPrefix;
		this.useHttps = target.protocol === "https:";
		this.tool = config.tool;
		this.routes = config.routes;
		this.modelRoutes = config.modelRoutes;

		this.config = {
			port: config.port || 0,
			logDirectory: config.logDirectory || ".claude-trace",
			logBaseName: config.logBaseName || "",
			includeAllRequests: config.includeAllRequests || false,
			openBrowser: config.openBrowser || false,
			logSensitiveHeaders: config.logSensitiveHeaders || false,
		};

		if (!fs.existsSync(this.config.logDirectory)) {
			fs.mkdirSync(this.config.logDirectory, { recursive: true });
		}

		const fileBaseName =
			this.config.logBaseName ||
			`log-${new Date().toISOString().replace(/[:.]/g, "-").replace("T", "-").slice(0, -5)}`;

		this.logFile = path.join(this.config.logDirectory, `${fileBaseName}.jsonl`);
		this.jsonFile = path.join(this.config.logDirectory, `${fileBaseName}.json`);
		this.htmlFile = path.join(this.config.logDirectory, `${fileBaseName}.html`);

		fs.writeFileSync(this.logFile, "");
		fs.writeFileSync(this.jsonFile, "[]");
		this.htmlGenerator = new HTMLGenerator();
	}

	private processHeaders(headers: IncomingHttpHeaders): Record<string, string> {
		const result: Record<string, string> = {};
		const sensitiveKeys = ["authorization", "x-api-key", "x-auth-token", "cookie", "set-cookie"];

		for (const [key, value] of Object.entries(headers)) {
			if (value === undefined) continue;
			const strValue = Array.isArray(value) ? value.join(", ") : value;

			if (this.config.logSensitiveHeaders) {
				result[key] = strValue;
			} else {
				const lowerKey = key.toLowerCase();
				if (sensitiveKeys.some((s) => lowerKey.includes(s))) {
					if (strValue.length > 14) {
						result[key] = `${strValue.substring(0, 10)}...${strValue.slice(-4)}`;
					} else if (strValue.length > 4) {
						result[key] = `${strValue.substring(0, 2)}...${strValue.slice(-2)}`;
					} else {
						result[key] = "[REDACTED]";
					}
				} else {
					result[key] = strValue;
				}
			}
		}

		return result;
	}

	private parseSSEEvents(body: string): SSEEvent[] {
		const events: SSEEvent[] = [];
		const lines = body.split("\n");
		let currentEvent = "";

		for (const line of lines) {
			if (line.startsWith("event: ")) {
				currentEvent = line.substring(7).trim();
			} else if (line.startsWith("data: ")) {
				const data = line.substring(6).trim();
				if (data === "[DONE]") break;
				try {
					const parsed: unknown = JSON.parse(data);
					const eventType =
						currentEvent ||
						(typeof parsed === "object" && parsed !== null && "type" in parsed
							? String((parsed as { type: unknown }).type)
							: "unknown");
					events.push({
						event: eventType,
						data: parsed,
						timestamp: new Date().toISOString(),
					});
				} catch {
					// Skip unparseable events
				}
			}
		}

		return events;
	}

	private writePairToLog(pair: RawPair): void {
		try {
			const jsonLine = JSON.stringify(pair) + "\n";
			fs.appendFileSync(this.logFile, jsonLine);
			fs.writeFileSync(this.jsonFile, JSON.stringify(this.pairs, null, 2));
		} catch (err) {
			traceRuntimeError(`Failed to write log: ${err}`, this.config.logDirectory);
		}
	}

	private async generateHTML(): Promise<void> {
		try {
			await this.htmlGenerator.generateHTML(this.pairs, this.htmlFile, {
				timestamp: new Date().toISOString().replace("T", " ").slice(0, -5),
				includeAllRequests: this.config.includeAllRequests,
				tool: this.tool,
			});
		} catch (err) {
			traceRuntimeError(`Failed to generate HTML: ${err}`, this.config.logDirectory);
		}
	}

	async start(): Promise<ProxyInfo> {
		return new Promise((resolve, reject) => {
			const httpServer = http.createServer((req, res) => {
				this.handleRequest(req, res);
			});

			this.server = httpServer;

			httpServer.on("error", (err) => {
				reject(err);
			});

			httpServer.listen(this.config.port, "127.0.0.1", () => {
				const address = httpServer.address();
				if (address && typeof address === "object") {
					const port = address.port;
					const url = `http://127.0.0.1:${port}`;
					console.error(`Logs will be written to:`);
					console.error(`  JSONL: ${path.resolve(this.logFile)}`);
					console.error(`  JSON:  ${path.resolve(this.jsonFile)}`);
					console.error(`  HTML:  ${path.resolve(this.htmlFile)}`);
					resolve({ port, url });
				} else {
					reject(new Error("Failed to get server address"));
				}
			});
		});
	}

	private handleRequest(req: IncomingMessage, res: ServerResponse): void {
		const requestTimestamp = Date.now();
		let requestBody = "";

		req.on("data", (chunk: Buffer | string) => {
			requestBody += chunk;
		});

		req.on("end", () => {
			const fallback = {
				protocol: this.targetProtocol,
				targetHost: this.targetHost,
				targetPort: this.targetPort,
				pathPrefix: this.pathPrefix,
			};

			const modelTarget =
				this.modelRoutes && Object.keys(this.modelRoutes).length > 0
					? resolveModelTarget(req.url, requestBody, this.modelRoutes, fallback)
					: null;

			if (this.modelRoutes && Object.keys(this.modelRoutes).length > 0 && !modelTarget) {
				res.writeHead(502);
				res.end("opencode-trace: could not resolve model from request body");
				return;
			}

			const routeTarget =
				modelTarget ??
				resolveRouteTarget(req.url, this.routes, fallback);

			const upstreamPath = routeTarget.upstreamDisplayPath;
			const upstreamUrl = `${routeTarget.protocol}//${routeTarget.targetHost}${upstreamPath}`;
			const useHttps = routeTarget.protocol === "https:";

			const options: https.RequestOptions = {
				hostname: routeTarget.targetHost,
				port: routeTarget.targetPort,
				path: upstreamPath,
				method: req.method,
				headers: {
					...req.headers,
					host: routeTarget.targetHost,
				},
			};

			const requestModule = useHttps ? https : http;
			const proxyReq = requestModule.request(options, (proxyRes) => {
				const responseTimestamp = Date.now();
				const responseChunks: Buffer[] = [];

				res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);

				proxyRes.on("data", (chunk: Buffer | string) => {
					responseChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
					res.write(chunk);
				});

				proxyRes.on("end", () => {
					void this.logResponse(
						req,
						proxyRes,
						requestTimestamp,
						responseTimestamp,
						requestBody,
						responseChunks,
						upstreamUrl,
						modelTarget !== null,
						modelTarget?.modelRoute,
					);
					res.end();
				});
			});

			proxyReq.on("error", (err) => {
				traceRuntimeError(
					`Proxy request error: ${err.message} (upstream: ${upstreamUrl})`,
					this.config.logDirectory,
				);
				res.writeHead(502);
				res.end(`Proxy error: ${err.message}`);
			});

			if (requestBody) {
				proxyReq.write(requestBody);
			}
			proxyReq.end();
		});
	}

	private async logResponse(
		req: IncomingMessage,
		proxyRes: IncomingMessage,
		requestTimestamp: number,
		responseTimestamp: number,
		requestBody: string,
		responseChunks: Buffer[],
		upstreamUrl: string,
		modelRouted: boolean = false,
		modelRoute?: ModelRoute,
	): Promise<void> {
		const shouldLog =
			this.config.includeAllRequests || isLlmApiPath(req.url) || modelRouted;

		if (!shouldLog) {
			traceDebug(`opencode-trace: skipped logging for ${req.method} ${req.url}`);
			return;
		}

		try {
		let parsedRequestBody: unknown = null;
		try {
			parsedRequestBody = requestBody ? JSON.parse(requestBody) : null;
		} catch {
			parsedRequestBody = requestBody || null;
		}

		const rawBuffer = Buffer.concat(responseChunks);
		let responseBody: string;
		const contentEncoding = (proxyRes.headers["content-encoding"] || "").toLowerCase();

		try {
			if (contentEncoding === "gzip") {
				responseBody = zlib.gunzipSync(rawBuffer).toString("utf-8");
			} else if (contentEncoding === "br") {
				responseBody = zlib.brotliDecompressSync(rawBuffer).toString("utf-8");
			} else if (contentEncoding === "deflate") {
				responseBody = zlib.inflateSync(rawBuffer).toString("utf-8");
			} else {
				responseBody = rawBuffer.toString("utf-8");
			}
		} catch {
			responseBody = rawBuffer.toString("utf-8");
		}

		const apiFormat = this.resolveResponseApiFormat(req.url, upstreamUrl, modelRoute);
		const parsedResponseBody = this.parseResponseBody(proxyRes, responseBody, apiFormat, parsedRequestBody);
		const pair: RawPair = {
			request: {
				timestamp: requestTimestamp / 1000,
				method: req.method || "GET",
				url: upstreamUrl,
				headers: this.processHeaders(req.headers),
				body: parsedRequestBody,
			},
			response: {
				timestamp: responseTimestamp / 1000,
				status_code: proxyRes.statusCode || 0,
				headers: this.processHeaders(proxyRes.headers),
				api_format: apiFormat !== "unknown" ? apiFormat : undefined,
				...parsedResponseBody,
			},
			logged_at: new Date().toISOString(),
		};

		this.pairs.push(pair);
		this.writePairToLog(pair);
		await this.generateHTML();
		} catch (err) {
			traceRuntimeError(`opencode-trace: failed to log response: ${err}`, this.config.logDirectory);
		}
	}

	private resolveResponseApiFormat(
		reqUrl: string | undefined,
		upstreamUrl: string,
		modelRoute?: ModelRoute,
	): ApiFormat {
		if (modelRoute?.apiFormat && modelRoute.apiFormat !== "unknown") {
			return modelRoute.apiFormat;
		}
		const fromReq = inferApiFormatFromPath(reqUrl);
		if (fromReq !== "unknown") {
			return fromReq;
		}
		return inferApiFormatFromUrl(upstreamUrl);
	}

	private parseResponseBody(
		proxyRes: IncomingMessage,
		responseBody: string,
		apiFormat: ApiFormat,
		requestBody: unknown,
	): Pick<NonNullable<RawPair["response"]>, "body" | "body_raw" | "events"> {
		const contentType = proxyRes.headers["content-type"] || "";
		const model =
			requestBody && typeof requestBody === "object" && "model" in requestBody
				? String((requestBody as { model: unknown }).model)
				: "unknown";

		try {
			if (contentType.includes("application/json")) {
				const parsed = JSON.parse(responseBody) as unknown;
				if (apiFormat === "openai" || ("choices" in (parsed as object))) {
					return { body: parseOpenAIChatCompletionBody(parsed, model) };
				}
				if (apiFormat === "openai-responses" || ("output" in (parsed as object))) {
					return { body: parseOpenAIResponsesBody(parsed, model) };
				}
				return { body: parsed };
			}

			if (contentType.includes("text/event-stream")) {
				const events = this.parseSSEEvents(responseBody);

				if (apiFormat === "openai") {
					try {
						const completion = buildOpenAIChatCompletionFromSSE(responseBody, model);
						return { body: parseOpenAIChatCompletionBody(completion, model), events };
					} catch {
						return { body_raw: responseBody, events };
					}
				}

				if (apiFormat === "openai-responses") {
					try {
						const responsesBody = buildOpenAIResponsesFromSSE(responseBody, model);
						return { body: parseOpenAIResponsesBody(responsesBody, model), events };
					} catch {
						return { body_raw: responseBody, events };
					}
				}

				const processor = new SharedConversationProcessor();
				try {
					const message: Message = processor.parseStreamingResponse(responseBody);
					return { body: message, events };
				} catch {
					return { body_raw: responseBody, events };
				}
			}

			return { body_raw: responseBody };
		} catch {
			return { body_raw: responseBody };
		}
	}

	stop(): void {
		if (this.stopped) {
			return;
		}
		this.stopped = true;

		if (this.server) {
			this.server.close();
			this.server = null;
		}

		console.error(`Logged ${this.pairs.length} request/response pairs`);

		if (this.config.openBrowser && fs.existsSync(this.htmlFile)) {
			this.openHtmlInBrowser(this.htmlFile);
		}
	}

	getHtmlFile(): string {
		return this.htmlFile;
	}

	private openHtmlInBrowser(htmlFile: string): void {
		try {
			if (process.platform === "win32") {
				spawn("cmd", ["/c", "start", "", htmlFile], { detached: true, stdio: "ignore" }).unref();
			} else {
				const cmd = process.platform === "darwin" ? "open" : "xdg-open";
				spawn(cmd, [htmlFile], { detached: true, stdio: "ignore" }).unref();
			}
			console.error(`Opening ${htmlFile} in browser`);
		} catch (err) {
			console.error(`Failed to open browser: ${err}`);
		}
	}
}
