/**
 * @file proxy-log-writer.ts
 * @description Shared JSONL/JSON/HTML logging for vibe-coding-proxy traffic.
 *
 * The forward proxy captures requests through a different protocol surface than
 * the existing reverse proxy, but the viewer expects the same RawPair shape.
 * This writer centralizes body decoding, sensitive header redaction, SSE parsing,
 * and real-time HTML regeneration for the independent proxy service.
 */

import * as fs from "fs";
import * as path from "path";
import * as zlib from "zlib";
import { spawn } from "child_process";
import type { IncomingHttpHeaders } from "http";
import type { Message } from "@anthropic-ai/sdk/resources/messages";
import {
	buildOpenAIChatCompletionFromSSE,
	buildOpenAIResponsesFromSSE,
	parseOpenAIChatCompletionBody,
	parseOpenAIResponsesBody,
} from "../adapt/openai-adapter";
import { inferApiFormatFromBody, inferApiFormatFromUrl } from "../adapt/api-format";
import { HTMLGenerator } from "../report/html-generator";
import { SharedConversationProcessor } from "../report/shared-conversation-processor";
import type { ApiFormat } from "../tools/types";
import type { RawPair, SSEEvent } from "../types";
import { traceRuntimeError } from "../cli/cli-common";

/** Runtime options for {@link ProxyLogWriter}. */
export interface ProxyLogWriterConfig {
	/** Directory for JSONL, JSON, and HTML log files. */
	logDirectory?: string;
	/** Base name for log files; defaults to a timestamped `log-...`. */
	logBaseName?: string;
	/** Include non-target traffic when the proxy asks to log metadata. */
	includeAllRequests?: boolean;
	/** Open the HTML report when the proxy stops. */
	openBrowser?: boolean;
	/** Log auth headers verbatim instead of redacting them. */
	logSensitiveHeaders?: boolean;
	/** Tool identifier embedded in report metadata. */
	tool?: string;
}

/** Files maintained by {@link ProxyLogWriter}. */
export interface ProxyLogPaths {
	jsonl: string;
	json: string;
	html: string;
}

/** Captured HTTP exchange passed from the proxy core into the log writer. */
export interface ProxyExchange {
	method: string;
	url: string;
	requestHeaders: IncomingHttpHeaders;
	requestBody: Buffer;
	statusCode: number;
	responseHeaders: IncomingHttpHeaders;
	responseChunks: Buffer[];
	requestTimestamp: number;
	responseTimestamp: number;
	forceLog?: boolean;
}

/** zlib shape with optional zstd support available in newer Node versions. */
type ZlibWithZstd = typeof zlib & { zstdDecompressSync?: (buffer: Buffer) => Buffer };

/**
 * Persists forward-proxy traffic using the same artifact set as existing CLIs.
 */
export class ProxyLogWriter {
	private readonly config: Required<Omit<ProxyLogWriterConfig, "tool">> & { tool?: string };
	private readonly paths: ProxyLogPaths;
	private readonly htmlGenerator = new HTMLGenerator();
	private readonly pairs: RawPair[] = [];

	/** @param config - Log location, redaction, and report options. */
	constructor(config: ProxyLogWriterConfig = {}) {
		this.config = {
			logDirectory: config.logDirectory || ".vibe-coding-proxy",
			logBaseName: config.logBaseName || "",
			includeAllRequests: config.includeAllRequests || false,
			openBrowser: config.openBrowser || false,
			logSensitiveHeaders: config.logSensitiveHeaders || false,
			tool: config.tool,
		};

		if (!fs.existsSync(this.config.logDirectory)) {
			fs.mkdirSync(this.config.logDirectory, { recursive: true });
		}

		const fileBaseName =
			this.config.logBaseName ||
			`log-${new Date().toISOString().replace(/[:.]/g, "-").replace("T", "-").slice(0, -5)}`;

		this.paths = {
			jsonl: path.join(this.config.logDirectory, `${fileBaseName}.jsonl`),
			json: path.join(this.config.logDirectory, `${fileBaseName}.json`),
			html: path.join(this.config.logDirectory, `${fileBaseName}.html`),
		};

		fs.writeFileSync(this.paths.jsonl, "");
		fs.writeFileSync(this.paths.json, "[]");
	}

	/** @returns Absolute paths for JSONL, JSON, and HTML artifacts. */
	getPaths(): ProxyLogPaths {
		return {
			jsonl: path.resolve(this.paths.jsonl),
			json: path.resolve(this.paths.json),
			html: path.resolve(this.paths.html),
		};
	}

	/**
	 * Write a completed request/response exchange when it matches logging policy.
	 * @param exchange - Buffered HTTP request and response data.
	 */
	async logExchange(exchange: ProxyExchange): Promise<void> {
		if (!exchange.forceLog && !this.config.includeAllRequests) {
			return;
		}

		try {
			const requestBody = parseRequestBodyForLog(exchange.requestHeaders, exchange.requestBody);
			const responseBodyText = decodeBodyText(exchange.responseHeaders, Buffer.concat(exchange.responseChunks));
			const apiFormat = resolveApiFormat(exchange.url, requestBody);
			const parsedResponse = parseResponseBody(exchange.responseHeaders, responseBodyText, apiFormat, requestBody);

			const pair: RawPair = {
				request: {
					timestamp: exchange.requestTimestamp / 1000,
					method: exchange.method,
					url: exchange.url,
					headers: this.processHeaders(exchange.requestHeaders),
					body: requestBody,
				},
				response: {
					timestamp: exchange.responseTimestamp / 1000,
					status_code: exchange.statusCode,
					headers: this.processHeaders(exchange.responseHeaders),
					api_format: apiFormat !== "unknown" ? apiFormat : undefined,
					...parsedResponse,
				},
				logged_at: new Date().toISOString(),
			};
			await this.writePair(pair);
		} catch (error) {
			traceRuntimeError(`vibe-coding-proxy: failed to log exchange: ${error}`, this.config.logDirectory);
		}
	}

	/**
	 * Write CONNECT tunnel metadata when body logging is unavailable.
	 * @param authority - CONNECT target such as `api.example.com:443`.
	 * @param note - Reason this is metadata-only.
	 */
	async logConnectMetadata(authority: string, note: string): Promise<void> {
		if (!this.config.includeAllRequests) {
			return;
		}
		const now = Date.now() / 1000;
		await this.writePair({
			request: {
				timestamp: now,
				method: "CONNECT",
				url: authority,
				headers: {},
				body: null,
			},
			response: {
				timestamp: now,
				status_code: 200,
				headers: {},
				body: { tunnel: true },
			},
			logged_at: new Date().toISOString(),
			note,
		});
	}

	/** Print summary and optionally open the generated HTML report. */
	stop(): void {
		console.error(`Logged ${this.pairs.length} request/response pairs`);
		if (this.config.openBrowser && fs.existsSync(this.paths.html)) {
			this.openHtmlInBrowser(this.paths.html);
		}
	}

	/** Redact sensitive headers unless explicitly disabled. */
	private processHeaders(headers: IncomingHttpHeaders): Record<string, string> {
		const result: Record<string, string> = {};
		const sensitiveKeys = ["authorization", "x-api-key", "x-auth-token", "cookie", "set-cookie"];

		for (const [key, value] of Object.entries(headers)) {
			if (value === undefined) continue;
			const strValue = Array.isArray(value) ? value.join(", ") : value;
			if (this.config.logSensitiveHeaders) {
				result[key] = strValue;
				continue;
			}
			const lowerKey = key.toLowerCase();
			if (sensitiveKeys.some((sensitive) => lowerKey.includes(sensitive))) {
				result[key] = strValue.length > 14 ? `${strValue.substring(0, 10)}...${strValue.slice(-4)}` : "[REDACTED]";
			} else {
				result[key] = strValue;
			}
		}
		return result;
	}

	/** Append one pair to JSONL, rewrite JSON, and regenerate HTML. */
	private async writePair(pair: RawPair): Promise<void> {
		this.pairs.push(pair);
		fs.appendFileSync(this.paths.jsonl, JSON.stringify(pair) + "\n");
		fs.writeFileSync(this.paths.json, JSON.stringify(this.pairs, null, 2));
		await this.htmlGenerator.generateHTML(this.pairs, this.paths.html, {
			timestamp: new Date().toISOString().replace("T", " ").slice(0, -5),
			includeAllRequests: this.config.includeAllRequests,
			tool: this.config.tool,
		});
	}

	/** Open an HTML file in the platform default browser. */
	private openHtmlInBrowser(htmlFile: string): void {
		try {
			if (process.platform === "win32") {
				spawn("cmd", ["/c", "start", "", htmlFile], { detached: true, stdio: "ignore" }).unref();
			} else {
				const cmd = process.platform === "darwin" ? "open" : "xdg-open";
				spawn(cmd, [htmlFile], { detached: true, stdio: "ignore" }).unref();
			}
			console.error(`Opening ${htmlFile} in browser`);
		} catch (error) {
			traceRuntimeError(`vibe-coding-proxy: failed to open HTML report: ${error}`, this.config.logDirectory);
		}
	}
}

/** Decode and decompress a body buffer using the corresponding headers. */
function decodeBodyText(headers: IncomingHttpHeaders, buffer: Buffer): string {
	if (!buffer.length) {
		return "";
	}
	const encoding = String(headers["content-encoding"] || "").toLowerCase();
	try {
		if (encoding === "gzip") return zlib.gunzipSync(buffer).toString("utf-8");
		if (encoding === "br") return zlib.brotliDecompressSync(buffer).toString("utf-8");
		if (encoding === "deflate") return zlib.inflateSync(buffer).toString("utf-8");
		if (encoding === "zstd") {
			const zstdDecompressSync = (zlib as ZlibWithZstd).zstdDecompressSync;
			if (zstdDecompressSync) return zstdDecompressSync(buffer).toString("utf-8");
		}
	} catch {
		return buffer.toString("utf-8");
	}
	return buffer.toString("utf-8");
}

/** Parse a request body as JSON when possible, otherwise return raw text. */
function parseRequestBodyForLog(headers: IncomingHttpHeaders, buffer: Buffer): unknown {
	if (!buffer.length) {
		return null;
	}
	const text = decodeBodyText(headers, buffer);
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

/** Infer API format from URL and body shape. */
function resolveApiFormat(url: string, requestBody: unknown): ApiFormat {
	const fromUrl = inferApiFormatFromUrl(url);
	if (fromUrl !== "unknown") {
		return fromUrl;
	}
	return inferApiFormatFromBody(requestBody);
}

/** Parse response body into viewer-friendly fields. */
function parseResponseBody(
	headers: IncomingHttpHeaders,
	responseBody: string,
	apiFormat: ApiFormat,
	requestBody: unknown,
): Pick<NonNullable<RawPair["response"]>, "body" | "body_raw" | "events"> {
	const contentType = String(headers["content-type"] || "");
	const model =
		requestBody && typeof requestBody === "object" && "model" in requestBody
			? String((requestBody as { model: unknown }).model)
			: "unknown";

	try {
		if (contentType.includes("application/json")) {
			const parsed = JSON.parse(responseBody) as unknown;
			if (parsed && typeof parsed === "object" && "error" in parsed) {
				return { body: parsed };
			}
			if (apiFormat === "openai" || (parsed && typeof parsed === "object" && "choices" in parsed)) {
				return { body: parseOpenAIChatCompletionBody(parsed, model) };
			}
			if (apiFormat === "openai-responses" || (parsed && typeof parsed === "object" && "output" in parsed)) {
				return { body: parseOpenAIResponsesBody(parsed, model) };
			}
			return { body: parsed };
		}

		if (contentType.includes("text/event-stream")) {
			const events = parseSSEEvents(responseBody);
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
			try {
				const message: Message = new SharedConversationProcessor().parseStreamingResponse(responseBody);
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

/** Parse Server-Sent Events lines into structured event records. */
function parseSSEEvents(body: string): SSEEvent[] {
	const events: SSEEvent[] = [];
	let currentEvent = "";
	for (const line of body.split("\n")) {
		if (line.startsWith("event: ")) {
			currentEvent = line.substring(7).trim();
		} else if (line.startsWith("data: ")) {
			const data = line.substring(6).trim();
			if (data === "[DONE]") break;
			try {
				const parsed = JSON.parse(data) as unknown;
				const eventType =
					currentEvent ||
					(parsed && typeof parsed === "object" && "type" in parsed
						? String((parsed as { type: unknown }).type)
						: "unknown");
				events.push({ event: eventType, data: parsed, timestamp: new Date().toISOString() });
			} catch {
				// Keep logging robust when one SSE line is malformed.
			}
		}
	}
	return events;
}
