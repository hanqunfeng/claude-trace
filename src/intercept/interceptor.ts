/**
 * @file Runtime fetch/HTTP interceptor for Claude Code V1 (Node.js script mode).
 *
 * Patches `global.fetch` and Node's `http`/`https` modules to capture Anthropic
 * Messages API traffic (and optionally AWS Bedrock) before it reaches the upstream.
 * Used when Claude Code is launched as a Node.js script via `--require interceptor-loader.js`.
 * Native V2+ binaries use {@link ReverseProxyServer} instead.
 */

import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { RawPair } from "../types";
import { HTMLGenerator } from "../report/html-generator";

/** Configuration for {@link ClaudeTrafficLogger}. */
export interface InterceptorConfig {
	/** Directory for JSONL and HTML log files. */
	logDirectory?: string;
	/** Base name for log files; falls back to env `CLAUDE_TRACE_LOG_NAME` or timestamp. */
	logBaseName?: string;
	/** Regenerate HTML after each logged pair. */
	enableRealTimeHTML?: boolean;
	/** Console log verbosity (currently unused; reserved for future use). */
	logLevel?: "debug" | "info" | "warn" | "error";
}

/**
 * Captures Claude API request/response pairs by monkey-patching fetch and Node HTTP.
 *
 * Writes append-only JSONL logs and optionally regenerates a self-contained HTML
 * report after each exchange. Sensitive headers are redacted by default.
 */
export class ClaudeTrafficLogger {
	/** Absolute path to the log directory. */
	private logDir: string;
	/** Append-only JSONL log file path. */
	private logFile: string;
	/** Self-contained HTML report output path. */
	private htmlFile: string;
	/** In-flight requests awaiting a matching response (keyed by generated request id). */
	private pendingRequests: Map<string, any> = new Map();
	/** Completed request/response pairs held in memory for HTML regeneration. */
	private pairs: RawPair[] = [];
	/** Resolved configuration with defaults applied. */
	private config: InterceptorConfig;
	/** Frontend bundle renderer for HTML reports. */
	private htmlGenerator: HTMLGenerator;

	/**
	 * Initializes log paths, creates the log directory, and clears the JSONL file.
	 *
	 * @param config - Logger configuration; sensible defaults are applied.
	 */
	constructor(config: InterceptorConfig = {}) {
		this.config = {
			logDirectory: ".claude-trace",
			enableRealTimeHTML: true,
			logLevel: "info",
			...config,
		};

		this.logDir = this.config.logDirectory!;
		if (!fs.existsSync(this.logDir)) {
			fs.mkdirSync(this.logDir, { recursive: true });
		}

		// Prefer explicit config, then env override, then timestamped default.
		const logBaseName = config?.logBaseName || process.env.CLAUDE_TRACE_LOG_NAME;
		const fileBaseName =
			logBaseName || `log-${new Date().toISOString().replace(/[:.]/g, "-").replace("T", "-").slice(0, -5)}`;

		this.logFile = path.join(this.logDir, `${fileBaseName}.jsonl`);
		this.htmlFile = path.join(this.logDir, `${fileBaseName}.html`);

		this.htmlGenerator = new HTMLGenerator();

		fs.writeFileSync(this.logFile, "");

		console.log(`Logs will be written to:`);
		console.log(`  JSONL: ${path.resolve(this.logFile)}`);
		console.log(`  HTML:  ${path.resolve(this.htmlFile)}`);
	}

	/**
	 * Returns true when a URL targets the Claude Messages API (or all Anthropic/Bedrock
	 * traffic when `CLAUDE_TRACE_INCLUDE_ALL_REQUESTS=true`).
	 *
	 * Respects `ANTHROPIC_BASE_URL` for custom proxy endpoints.
	 *
	 * @param url - Request URL as a string or `URL` object.
	 */
	private isClaudeAPI(url: string | URL): boolean {
		const urlString = typeof url === "string" ? url : url.toString();
		const includeAllRequests = process.env.CLAUDE_TRACE_INCLUDE_ALL_REQUESTS === "true";

		// Support custom ANTHROPIC_BASE_URL (e.g. when already pointing at a local proxy).
		const baseUrl = process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com";
		const apiHost = new URL(baseUrl).hostname;

		const isAnthropicAPI = urlString.includes(apiHost);

		// AWS Bedrock uses a different host pattern but the same Messages API shape.
		const isBedrockAPI = urlString.includes("bedrock-runtime.") && urlString.includes(".amazonaws.com");

		if (includeAllRequests) {
			return isAnthropicAPI || isBedrockAPI;
		}

		return (isAnthropicAPI && urlString.includes("/v1/messages")) || isBedrockAPI;
	}

	/** Generates a unique correlation id for pairing requests with responses. */
	private generateRequestId(): string {
		return `req_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
	}

	/**
	 * Redacts sensitive header values by truncating to prefix/suffix.
	 *
	 * @param headers - Flat header map from fetch or Node HTTP options.
	 * @returns Copy of headers with sensitive values partially redacted.
	 */
	private redactSensitiveHeaders(headers: Record<string, string>): Record<string, string> {
		const redactedHeaders = { ...headers };
		const sensitiveKeys = [
			"authorization",
			"x-api-key",
			"x-auth-token",
			"cookie",
			"set-cookie",
			"x-session-token",
			"x-access-token",
			"bearer",
			"proxy-authorization",
		];

		for (const key of Object.keys(redactedHeaders)) {
			const lowerKey = key.toLowerCase();
			if (sensitiveKeys.some((sensitive) => lowerKey.includes(sensitive))) {
				const value = redactedHeaders[key];
				if (value && value.length > 14) {
					redactedHeaders[key] = `${value.substring(0, 10)}...${value.slice(-4)}`;
				} else if (value && value.length > 4) {
					redactedHeaders[key] = `${value.substring(0, 2)}...${value.slice(-2)}`;
				} else {
					redactedHeaders[key] = "[REDACTED]";
				}
			}
		}

		return redactedHeaders;
	}

	/** Clones a fetch Response so the body can be read for logging without consuming it. */
	private async cloneResponse(response: Response): Promise<Response> {
		return response.clone();
	}

	/**
	 * Normalizes request body into a log-friendly value.
	 *
	 * Parses JSON strings, expands FormData entries, and passes through other types.
	 *
	 * @param body - Raw request body from fetch `init.body` or Node `req.write` chunks.
	 */
	private async parseRequestBody(body: any): Promise<any> {
		if (!body) return null;

		if (typeof body === "string") {
			try {
				return JSON.parse(body);
			} catch {
				return body;
			}
		}

		if (body instanceof FormData) {
			const formObject: Record<string, any> = {};
			for (const [key, value] of body.entries()) {
				formObject[key] = value;
			}
			return formObject;
		}

		return body;
	}

	/**
	 * Reads and classifies a fetch Response body for logging.
	 *
	 * JSON responses are parsed; SSE and text responses are stored as raw strings.
	 *
	 * @param response - Cloned fetch Response (safe to consume).
	 */
	private async parseResponseBody(response: Response): Promise<{ body?: any; body_raw?: string }> {
		const contentType = response.headers.get("content-type") || "";

		try {
			if (contentType.includes("application/json")) {
				const body = await response.json();
				return { body };
			} else if (contentType.includes("text/event-stream")) {
				const body_raw = await response.text();
				return { body_raw };
			} else if (contentType.includes("text/")) {
				const body_raw = await response.text();
				return { body_raw };
			} else {
				const body_raw = await response.text();
				return { body_raw };
			}
		} catch (error) {
			// Swallow parse errors so instrumentation never breaks the client request.
			return {};
		}
	}

	/** Installs both fetch and Node HTTP instrumentation. */
	public instrumentAll(): void {
		this.instrumentFetch();
		this.instrumentNodeHTTP();
	}

	/**
	 * Patches `global.fetch` to intercept Claude API calls.
	 *
	 * Idempotent: skips if already marked with `__claudeTraceInstrumented`.
	 * Non-Claude URLs pass through to the original fetch unchanged.
	 */
	public instrumentFetch(): void {
		if (!global.fetch) {
			return;
		}

		// Prevent double-patching when the loader or hot-reload re-enters initialization.
		if ((global.fetch as any).__claudeTraceInstrumented) {
			return;
		}

		const originalFetch = global.fetch;
		const logger = this;

		global.fetch = async function (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

			if (!logger.isClaudeAPI(url)) {
				return originalFetch(input, init);
			}

			const requestId = logger.generateRequestId();
			const requestTimestamp = Date.now();

			const requestData = {
				// Seconds since epoch to match Python claude-trace log format.
				timestamp: requestTimestamp / 1000,
				method: init.method || "GET",
				url: url,
				headers: logger.redactSensitiveHeaders(Object.fromEntries(new Headers(init.headers || {}).entries())),
				body: await logger.parseRequestBody(init.body),
			};

			logger.pendingRequests.set(requestId, requestData);

			try {
				const response = await originalFetch(input, init);
				const responseTimestamp = Date.now();

				const clonedResponse = await logger.cloneResponse(response);
				const responseBodyData = await logger.parseResponseBody(clonedResponse);

				const responseData = {
					timestamp: responseTimestamp / 1000,
					status_code: response.status,
					headers: logger.redactSensitiveHeaders(Object.fromEntries(response.headers.entries())),
					...responseBodyData,
				};

				const pair: RawPair = {
					request: requestData,
					response: responseData,
					logged_at: new Date().toISOString(),
				};

				logger.pendingRequests.delete(requestId);
				logger.pairs.push(pair);

				await logger.writePairToLog(pair);

				if (logger.config.enableRealTimeHTML) {
					await logger.generateHTML();
				}

				return response;
			} catch (error) {
				logger.pendingRequests.delete(requestId);
				throw error;
			}
		};

		(global.fetch as any).__claudeTraceInstrumented = true;
	}

	/**
	 * Patches Node's `http` and `https` `request`/`get` methods.
	 *
	 * Some Claude Code versions use Node HTTP instead of fetch for API calls.
	 * Each method is patched at most once via a `__claudeTraceInstrumented` marker.
	 */
	public instrumentNodeHTTP(): void {
		try {
			const http = require("http");
			const https = require("https");
			const logger = this;

			if (http.request && !(http.request as any).__claudeTraceInstrumented) {
				const originalHttpRequest = http.request;
				http.request = function (options: any, callback?: any) {
					return logger.interceptNodeRequest(originalHttpRequest, options, callback, false);
				};
				(http.request as any).__claudeTraceInstrumented = true;
			}

			if (http.get && !(http.get as any).__claudeTraceInstrumented) {
				const originalHttpGet = http.get;
				http.get = function (options: any, callback?: any) {
					return logger.interceptNodeRequest(originalHttpGet, options, callback, false);
				};
				(http.get as any).__claudeTraceInstrumented = true;
			}

			if (https.request && !(https.request as any).__claudeTraceInstrumented) {
				const originalHttpsRequest = https.request;
				https.request = function (options: any, callback?: any) {
					return logger.interceptNodeRequest(originalHttpsRequest, options, callback, true);
				};
				(https.request as any).__claudeTraceInstrumented = true;
			}

			if (https.get && !(https.get as any).__claudeTraceInstrumented) {
				const originalHttpsGet = https.get;
				https.get = function (options: any, callback?: any) {
					return logger.interceptNodeRequest(originalHttpsGet, options, callback, true);
				};
				(https.get as any).__claudeTraceInstrumented = true;
			}
		} catch (error) {
			// http/https may be unavailable in some embedded runtimes; fail silently.
		}
	}

	/**
	 * Wraps a Node HTTP(S) request to capture body and response for Claude API URLs.
	 *
	 * Intercepts `req.write` to accumulate the request body, then logs on `res.end`.
	 *
	 * @param originalRequest - Unpatched `http.request` or `https.request`.
	 * @param options - Request options or URL string.
	 * @param callback - Optional response callback passed to the original request.
	 * @param isHttps - Whether the underlying module is `https`.
	 * @returns The outbound `ClientRequest` with wrapped `write`.
	 */
	private interceptNodeRequest(originalRequest: any, options: any, callback: any, isHttps: boolean) {
		const url = this.parseNodeRequestURL(options, isHttps);

		if (!this.isClaudeAPI(url)) {
			return originalRequest.call(this, options, callback);
		}

		const requestTimestamp = Date.now();
		let requestBody = "";

		const req = originalRequest.call(this, options, (res: any) => {
			const responseTimestamp = Date.now();
			let responseBody = "";

			res.on("data", (chunk: any) => {
				responseBody += chunk;
			});

			res.on("end", async () => {
				const requestData = {
					timestamp: requestTimestamp / 1000,
					method: options.method || "GET",
					url: url,
					headers: this.redactSensitiveHeaders(options.headers || {}),
					body: requestBody ? await this.parseRequestBody(requestBody) : null,
				};

				const responseData = {
					timestamp: responseTimestamp / 1000,
					status_code: res.statusCode,
					headers: this.redactSensitiveHeaders(res.headers || {}),
					...(await this.parseResponseBodyFromString(responseBody, res.headers["content-type"])),
				};

				const pair: RawPair = {
					request: requestData,
					response: responseData,
					logged_at: new Date().toISOString(),
				};

				this.pairs.push(pair);
				await this.writePairToLog(pair);

				if (this.config.enableRealTimeHTML) {
					await this.generateHTML();
				}
			});

			if (callback) {
				callback(res);
			}
		});

		// Node HTTP does not expose the body until write/end; wrap write to capture it.
		const originalWrite = req.write;
		req.write = function (chunk: any) {
			if (chunk) {
				requestBody += chunk;
			}
			return originalWrite.call(this, chunk);
		};

		return req;
	}

	/**
	 * Reconstructs a full URL string from Node HTTP request options.
	 *
	 * @param options - URL string or options object with host/path fields.
	 * @param isHttps - Whether the caller is the `https` module.
	 */
	private parseNodeRequestURL(options: any, isHttps: boolean): string {
		if (typeof options === "string") {
			return options;
		}

		const protocol = isHttps ? "https:" : "http:";
		const hostname = options.hostname || options.host || "localhost";
		const port = options.port ? `:${options.port}` : "";
		const path = options.path || "/";

		return `${protocol}//${hostname}${port}${path}`;
	}

	/**
	 * Parses a raw response body string based on Content-Type (Node HTTP path).
	 *
	 * @param body - Accumulated response body from `res.on("data")`.
	 * @param contentType - Value of the `content-type` response header, if any.
	 */
	private async parseResponseBodyFromString(
		body: string,
		contentType?: string,
	): Promise<{ body?: any; body_raw?: string }> {
		try {
			if (contentType && contentType.includes("application/json")) {
				return { body: JSON.parse(body) };
			} else if (contentType && contentType.includes("text/event-stream")) {
				return { body_raw: body };
			} else {
				return { body_raw: body };
			}
		} catch (error) {
			return { body_raw: body };
		}
	}

	/** Appends a single JSONL line for one request/response pair. */
	private async writePairToLog(pair: RawPair): Promise<void> {
		try {
			const jsonLine = JSON.stringify(pair) + "\n";
			fs.appendFileSync(this.logFile, jsonLine);
		} catch (error) {
			// Swallow write errors so logging never crashes the instrumented process.
		}
	}

	/** Regenerates the self-contained HTML report from all logged pairs. */
	private async generateHTML(): Promise<void> {
		try {
			const includeAllRequests = process.env.CLAUDE_TRACE_INCLUDE_ALL_REQUESTS === "true";
			await this.htmlGenerator.generateHTML(this.pairs, this.htmlFile, {
				timestamp: new Date().toISOString().replace("T", " ").slice(0, -5),
				includeAllRequests,
				tool: "claude",
			});
		} catch (error) {
			// HTML generation is best-effort; failures should not affect the client.
		}
	}

	/**
	 * Flushes orphaned pending requests and optionally opens the HTML report.
	 *
	 * Called on process exit via {@link initializeInterceptor}. Requests that never
	 * received a response are logged with a `ORPHANED_REQUEST` note.
	 */
	public cleanup(): void {
		console.log("Cleaning up orphaned requests...");

		for (const [, requestData] of this.pendingRequests.entries()) {
			const orphanedPair = {
				request: requestData,
				response: null,
				note: "ORPHANED_REQUEST - No matching response received",
				logged_at: new Date().toISOString(),
			};

			try {
				const jsonLine = JSON.stringify(orphanedPair) + "\n";
				fs.appendFileSync(this.logFile, jsonLine);
			} catch (error) {
				console.log(`Error writing orphaned request: ${error}`);
			}
		}

		this.pendingRequests.clear();
		console.log(`Cleanup complete. Logged ${this.pairs.length} pairs`);

		const shouldOpenBrowser = process.env.CLAUDE_TRACE_OPEN_BROWSER === "true";
		if (shouldOpenBrowser && fs.existsSync(this.htmlFile)) {
			try {
				spawn("open", [this.htmlFile], { detached: true, stdio: "ignore" }).unref();
				console.log(`Opening ${this.htmlFile} in browser`);
			} catch (error) {
				console.log(`Failed to open browser: ${error}`);
			}
		}
	}

	/**
	 * Returns current logging statistics and output file paths.
	 *
	 * @returns Snapshot of pair count, pending request count, and log file paths.
	 */
	public getStats() {
		return {
			totalPairs: this.pairs.length,
			pendingRequests: this.pendingRequests.size,
			logFile: this.logFile,
			htmlFile: this.htmlFile,
		};
	}
}

/** Singleton logger instance shared across the process. */
let globalLogger: ClaudeTrafficLogger | null = null;

/** Guards against registering duplicate process exit handlers. */
let eventListenersSetup = false;

/**
 * Creates and activates the global traffic logger (singleton).
 *
 * Patches fetch/HTTP immediately and registers cleanup handlers for
 * `exit`, `SIGINT`, `SIGTERM`, and `uncaughtException`.
 *
 * @param config - Optional logger configuration.
 * @returns The active {@link ClaudeTrafficLogger} instance.
 */
export function initializeInterceptor(config?: InterceptorConfig): ClaudeTrafficLogger {
	if (globalLogger) {
		console.warn("Interceptor already initialized");
		return globalLogger;
	}

	globalLogger = new ClaudeTrafficLogger(config);
	globalLogger.instrumentAll();

	if (!eventListenersSetup) {
		const cleanup = () => {
			if (globalLogger) {
				globalLogger.cleanup();
			}
		};

		process.on("exit", cleanup);
		process.on("SIGINT", cleanup);
		process.on("SIGTERM", cleanup);
		process.on("uncaughtException", (error) => {
			console.error("Uncaught exception:", error);
			cleanup();
			process.exit(1);
		});

		eventListenersSetup = true;
	}

	return globalLogger;
}

/**
 * Returns the active logger instance, or `null` if not yet initialized.
 *
 * @returns Global {@link ClaudeTrafficLogger} or `null`.
 */
export function getLogger(): ClaudeTrafficLogger | null {
	return globalLogger;
}
