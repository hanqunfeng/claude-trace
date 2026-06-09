import * as https from "https";
import * as http from "http";
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "http";
import * as fs from "fs";
import * as path from "path";
import * as zlib from "zlib";
import { spawn } from "child_process";
import { HTMLGenerator } from "./html-generator";
import { SharedConversationProcessor } from "./shared-conversation-processor";
import type { RawPair, SSEEvent } from "./types";
import type { Message } from "@anthropic-ai/sdk/resources/messages";

export interface ReverseProxyConfig {
	port?: number;
	logDirectory?: string;
	logBaseName?: string;
	includeAllRequests?: boolean;
	openBrowser?: boolean;
	logSensitiveHeaders?: boolean;
	targetBaseUrl?: string;
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

export class ReverseProxyServer {
	private server: http.Server | null = null;
	private pairs: RawPair[] = [];
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

	constructor(config: ReverseProxyConfig = {}) {
		const target = parseTargetBaseUrl(config.targetBaseUrl);
		this.targetProtocol = target.protocol;
		this.targetHost = target.targetHost;
		this.targetPort = target.targetPort;
		this.pathPrefix = target.pathPrefix;
		this.useHttps = target.protocol === "https:";

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
			console.error(`Failed to write log: ${err}`);
		}
	}

	private async generateHTML(): Promise<void> {
		try {
			await this.htmlGenerator.generateHTML(this.pairs, this.htmlFile, {
				title: `${this.pairs.length} API Calls`,
				timestamp: new Date().toISOString().replace("T", " ").slice(0, -5),
				includeAllRequests: this.config.includeAllRequests,
			});
		} catch (err) {
			console.error(`Failed to generate HTML: ${err}`);
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
					console.log(`Logs will be written to:`);
					console.log(`  JSONL: ${path.resolve(this.logFile)}`);
					console.log(`  JSON:  ${path.resolve(this.jsonFile)}`);
					console.log(`  HTML:  ${path.resolve(this.htmlFile)}`);
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
			const upstreamPath = `${this.pathPrefix}${req.url || "/"}`;
			const upstreamUrl = `${this.targetProtocol}//${this.targetHost}${upstreamPath}`;

			const options: https.RequestOptions = {
				hostname: this.targetHost,
				port: this.targetPort,
				path: upstreamPath,
				method: req.method,
				headers: {
					...req.headers,
					host: this.targetHost,
				},
			};

			const requestModule = this.useHttps ? https : http;
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
					);
					res.end();
				});
			});

			proxyReq.on("error", (err) => {
				console.error(`Proxy request error: ${err.message}`);
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
	): Promise<void> {
		const shouldLog =
			this.config.includeAllRequests || (req.url !== undefined && req.url.includes("/v1/messages"));

		if (!shouldLog) {
			return;
		}

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

		const parsedResponseBody = this.parseResponseBody(proxyRes, responseBody);
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
				...parsedResponseBody,
			},
			logged_at: new Date().toISOString(),
		};

		this.pairs.push(pair);
		this.writePairToLog(pair);
		await this.generateHTML();
	}

	private parseResponseBody(
		proxyRes: IncomingMessage,
		responseBody: string,
	): Pick<NonNullable<RawPair["response"]>, "body" | "body_raw" | "events"> {
		const contentType = proxyRes.headers["content-type"] || "";

		try {
			if (contentType.includes("application/json")) {
				return { body: JSON.parse(responseBody) as unknown };
			}

			if (contentType.includes("text/event-stream")) {
				const events = this.parseSSEEvents(responseBody);
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
		if (!this.server) {
			return;
		}

		console.log(`Logged ${this.pairs.length} request/response pairs`);

		if (this.config.openBrowser && fs.existsSync(this.htmlFile)) {
			try {
				if (process.platform === "win32") {
					spawn("cmd", ["/c", "start", "", this.htmlFile], { detached: true, stdio: "ignore" }).unref();
				} else {
					const cmd = process.platform === "darwin" ? "open" : "xdg-open";
					spawn(cmd, [this.htmlFile], { detached: true, stdio: "ignore" }).unref();
				}
				console.log(`Opening ${this.htmlFile} in browser`);
			} catch (err) {
				console.error(`Failed to open browser: ${err}`);
			}
		}

		this.server.close();
		this.server = null;
	}
}
