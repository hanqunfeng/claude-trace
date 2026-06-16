/**
 * @file forward-proxy.ts
 * @description Independent HTTP/HTTPS forward proxy for vibe-coding-proxy.
 *
 * Unlike the existing reverse proxy, this server is configured through
 * HTTP_PROXY/HTTPS_PROXY and does not spawn or manage any coding CLI process.
 * HTTPS traffic is tunneled by default; only allowlisted hosts are decrypted
 * with the local MITM CA so model API JSON can be logged.
 */

import * as http from "http";
import * as https from "https";
import * as net from "net";
import * as tls from "tls";
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "http";
import { traceRuntimeError } from "../cli/cli-common";
import { MitmCertificateAuthority, defaultCaDir } from "./mitm-cert";
import { ProxyLogWriter, type ProxyLogPaths } from "./proxy-log-writer";
import { ProxyTargetMatcher, splitHostPort } from "./proxy-targets";

/** Configuration for {@link ForwardProxyServer}. */
export interface ForwardProxyConfig {
	/** TCP host to bind; defaults to loopback for safety. */
	host?: string;
	/** TCP port to bind; `0` lets the OS pick an ephemeral port. */
	port?: number;
	/** Directory for JSONL, JSON, and HTML logs. */
	logDirectory?: string;
	/** Base name for log files. */
	logBaseName?: string;
	/** Log metadata for non-target traffic as well. */
	includeAllRequests?: boolean;
	/** Open generated HTML when the proxy stops. */
	openBrowser?: boolean;
	/** Keep sensitive headers unredacted in logs. */
	logSensitiveHeaders?: boolean;
	/** URL prefixes that should be decrypted and fully logged. */
	targetUrls?: string[];
	/** Hostnames that should be decrypted and fully logged. */
	mitmHosts?: string[];
	/** Disable MITM; HTTPS CONNECT is tunneled only. */
	disableMitm?: boolean;
	/** Persistent local CA directory. */
	caDir?: string;
}

/** Resolved listen address returned by {@link ForwardProxyServer.start}. */
export interface ForwardProxyInfo {
	host: string;
	port: number;
	url: string;
	logs: ProxyLogPaths;
	caCertPath?: string;
}

/** Internal forwarding target for an HTTP exchange. */
interface ForwardTarget {
	protocol: "http:" | "https:";
	hostname: string;
	port: number;
	path: string;
	fullUrl: string;
}

/** Hop-by-hop headers that must not be forwarded upstream. */
const HOP_BY_HOP_HEADERS = new Set([
	"connection",
	"keep-alive",
	"proxy-authenticate",
	"proxy-authorization",
	"proxy-connection",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
]);

/**
 * HTTP forward proxy with optional allowlist-scoped HTTPS MITM logging.
 */
export class ForwardProxyServer {
	private readonly config: Required<
		Omit<ForwardProxyConfig, "targetUrls" | "mitmHosts" | "caDir">
	> & { caDir: string };
	private readonly targets: ProxyTargetMatcher;
	private readonly logger: ProxyLogWriter;
	private readonly ca: MitmCertificateAuthority;
	private readonly server: http.Server;
	private readonly mitmHttpServer: http.Server;
	private readonly mitmSocketHosts = new WeakMap<object, string>();
	private started = false;
	private stopped = false;

	/** @param config - Bind, logging, target matching, and MITM options. */
	constructor(config: ForwardProxyConfig = {}) {
		this.config = {
			host: config.host || "127.0.0.1",
			port: config.port ?? 0,
			logDirectory: config.logDirectory || ".vibe-coding-proxy",
			logBaseName: config.logBaseName || "",
			includeAllRequests: config.includeAllRequests || false,
			openBrowser: config.openBrowser || false,
			logSensitiveHeaders: config.logSensitiveHeaders || false,
			disableMitm: config.disableMitm || false,
			caDir: config.caDir || defaultCaDir(),
		};
		this.targets = new ProxyTargetMatcher({
			targetUrls: config.targetUrls,
			mitmHosts: config.mitmHosts,
		});
		this.logger = new ProxyLogWriter({
			logDirectory: this.config.logDirectory,
			logBaseName: this.config.logBaseName,
			includeAllRequests: this.config.includeAllRequests,
			openBrowser: this.config.openBrowser,
			logSensitiveHeaders: this.config.logSensitiveHeaders,
			tool: "vibe-coding-proxy",
		});
		this.ca = new MitmCertificateAuthority(this.config.caDir);
		this.server = http.createServer((req, res) => {
			this.handlePlainHttpRequest(req, res);
		});
		this.server.on("connect", (req, socket, head) => {
			this.handleConnect(req, socket as net.Socket, head);
		});
		this.server.on("clientError", (_error, socket) => {
			socket.destroy();
		});
		this.mitmHttpServer = http.createServer((req, res) => {
			this.handleMitmHttpRequest(req, res);
		});
		this.mitmHttpServer.on("clientError", (_error, socket) => {
			socket.destroy();
		});
	}

	/**
	 * Start the forward proxy and return the URL clients should use.
	 * @returns Listen information, log paths, and CA certificate path when MITM is enabled.
	 */
	async start(): Promise<ForwardProxyInfo> {
		if (this.started) {
			throw new Error("Forward proxy is already started");
		}
		if (!this.config.disableMitm && this.targets.isEmpty()) {
			throw new Error("At least one --target-url or --mitm-host is required when MITM is enabled");
		}
		const caInfo = this.config.disableMitm ? undefined : this.ca.ensureAuthority();

		return new Promise((resolve, reject) => {
			this.server.once("error", reject);
			this.server.listen(this.config.port, this.config.host, () => {
				this.started = true;
				this.server.off("error", reject);
				const address = this.server.address();
				if (!address || typeof address === "string") {
					reject(new Error("Failed to resolve proxy listen address"));
					return;
				}
				const url = `http://${this.config.host}:${address.port}`;
				resolve({
					host: this.config.host,
					port: address.port,
					url,
					logs: this.logger.getPaths(),
					caCertPath: caInfo?.certPath,
				});
			});
		});
	}

	/** Stop the proxy and finalize logging output. */
	stop(): void {
		if (this.stopped) {
			return;
		}
		this.stopped = true;
		this.server.close();
		try {
			this.mitmHttpServer.close();
		} catch {
			// The MITM parser server is fed accepted sockets manually and may never listen.
		}
		this.logger.stop();
	}

	/** Handle non-CONNECT requests sent through HTTP_PROXY. */
	private handlePlainHttpRequest(req: IncomingMessage, res: ServerResponse): void {
		let target: ForwardTarget;
		try {
			target = resolvePlainHttpTarget(req);
		} catch (error) {
			res.writeHead(400);
			res.end(`Bad proxy request: ${(error as Error).message}`);
			return;
		}
		void this.forwardHttpExchange(req, res, target, this.targets.shouldLogUrl(target.fullUrl));
	}

	/** Handle HTTPS CONNECT by tunneling or starting allowlist-scoped MITM. */
	private handleConnect(req: IncomingMessage, clientSocket: net.Socket, head: Buffer): void {
		const authority = req.url || "";
		const { hostname, port } = splitHostPort(authority);
		clientSocket.on("error", (error) => {
			traceRuntimeError(`vibe-coding-proxy: client socket error for ${authority}: ${error.message}`, this.config.logDirectory);
		});

		if (this.config.disableMitm || !this.targets.shouldMitmHost(authority)) {
			this.tunnelConnect(authority, hostname, port, clientSocket, head);
			return;
		}

		try {
			const pair = this.ca.getCertificateForHost(hostname);
			clientSocket.write("HTTP/1.1 200 Connection Established\r\nProxy-agent: vibe-coding-proxy\r\n\r\n");
			const secureContext = tls.createSecureContext({ key: pair.key, cert: pair.cert });
			const tlsSocket = new tls.TLSSocket(clientSocket, {
				isServer: true,
				secureContext,
			});
			if (head.length > 0) {
				tlsSocket.unshift(head);
			}
			tlsSocket.once("secure", () => {
				this.mitmSocketHosts.set(tlsSocket, hostname);
				this.mitmHttpServer.emit("connection", tlsSocket);
			});
			tlsSocket.on("error", (error) => {
				traceRuntimeError(`vibe-coding-proxy: MITM TLS error for ${authority}: ${error.message}`, this.config.logDirectory);
			});
		} catch (error) {
			traceRuntimeError(`vibe-coding-proxy: failed MITM setup for ${authority}: ${error}`, this.config.logDirectory);
			clientSocket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
			clientSocket.destroy();
		}
	}

	/** Handle HTTP requests after CONNECT TLS has been decrypted. */
	private handleMitmHttpRequest(req: IncomingMessage, res: ServerResponse): void {
		const host = this.mitmSocketHosts.get(req.socket) || String(req.headers.host || "");
		let target: ForwardTarget;
		try {
			target = resolveMitmTarget(req, host);
		} catch (error) {
			res.writeHead(400);
			res.end(`Bad MITM request: ${(error as Error).message}`);
			return;
		}
		void this.forwardHttpExchange(req, res, target, this.targets.shouldLogUrl(target.fullUrl));
	}

	/** Open a raw TCP tunnel for non-MITM CONNECT targets. */
	private tunnelConnect(
		authority: string,
		hostname: string,
		port: number,
		clientSocket: net.Socket,
		head: Buffer,
	): void {
		const upstream = net.connect(port, hostname, () => {
			clientSocket.write("HTTP/1.1 200 Connection Established\r\nProxy-agent: vibe-coding-proxy\r\n\r\n");
			if (head.length > 0) {
				upstream.write(head);
			}
			upstream.pipe(clientSocket);
			clientSocket.pipe(upstream);
			void this.logger.logConnectMetadata(authority, "CONNECT tunnel passed through without MITM");
		});
		upstream.on("error", (error) => {
			traceRuntimeError(`vibe-coding-proxy: CONNECT error for ${authority}: ${error.message}`, this.config.logDirectory);
			if (!clientSocket.destroyed) {
				clientSocket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
			}
			clientSocket.destroy();
		});
		upstream.on("end", () => {
			clientSocket.end();
		});
		clientSocket.on("end", () => {
			upstream.end();
		});
	}

	/** Forward a buffered HTTP request upstream while streaming the response back. */
	private forwardHttpExchange(
		req: IncomingMessage,
		res: ServerResponse,
		target: ForwardTarget,
		forceLog: boolean,
	): void {
		const requestTimestamp = Date.now();
		const requestBodyChunks: Buffer[] = [];
		req.on("data", (chunk: Buffer | string) => {
			requestBodyChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
		});
		req.on("error", (error) => {
			traceRuntimeError(`vibe-coding-proxy: request stream error for ${target.fullUrl}: ${error.message}`, this.config.logDirectory);
			if (!res.headersSent) {
				res.writeHead(499);
			}
			res.end();
		});
		res.on("error", (error) => {
			traceRuntimeError(`vibe-coding-proxy: response stream error for ${target.fullUrl}: ${error.message}`, this.config.logDirectory);
		});
		req.on("end", () => {
			const requestBody = Buffer.concat(requestBodyChunks);
			const requestHeaders = buildUpstreamHeaders(req.headers, target);
			const requestOptions: https.RequestOptions = {
				protocol: target.protocol,
				hostname: target.hostname,
				port: target.port,
				path: target.path,
				method: req.method,
				headers: requestHeaders,
			};
			const requestModule = target.protocol === "https:" ? https : http;
			const upstreamReq = requestModule.request(requestOptions, (upstreamRes) => {
				const responseTimestamp = Date.now();
				const responseChunks: Buffer[] = [];
				res.writeHead(upstreamRes.statusCode || 200, upstreamRes.headers);
				upstreamRes.on("data", (chunk: Buffer | string) => {
					const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
					responseChunks.push(buffer);
					res.write(buffer);
				});
				upstreamRes.on("error", (error) => {
					traceRuntimeError(`vibe-coding-proxy: upstream response error for ${target.fullUrl}: ${error.message}`, this.config.logDirectory);
					res.end();
				});
				upstreamRes.on("end", () => {
					res.end();
					void this.logger.logExchange({
						method: req.method || "GET",
						url: target.fullUrl,
						requestHeaders: req.headers,
						requestBody,
						statusCode: upstreamRes.statusCode || 0,
						responseHeaders: upstreamRes.headers,
						responseChunks,
						requestTimestamp,
						responseTimestamp,
						forceLog,
					});
				});
			});
			upstreamReq.on("error", (error) => {
				traceRuntimeError(`vibe-coding-proxy: upstream error for ${target.fullUrl}: ${error.message}`, this.config.logDirectory);
				if (!res.headersSent) {
					res.writeHead(502);
					res.end(`Proxy error: ${error.message}`);
					return;
				}
				res.end();
			});
			if (requestBody.length > 0) {
				upstreamReq.write(requestBody);
			}
			upstreamReq.end();
		});
	}
}

/** Resolve absolute-form requests used by HTTP forward proxies. */
function resolvePlainHttpTarget(req: IncomingMessage): ForwardTarget {
	const rawUrl = req.url || "/";
	const parsed = rawUrl.startsWith("http://") || rawUrl.startsWith("https://")
		? new URL(rawUrl)
		: new URL(`http://${String(req.headers.host || "")}${rawUrl}`);
	return urlToTarget(parsed);
}

/** Resolve origin-form requests seen inside the decrypted CONNECT tunnel. */
function resolveMitmTarget(req: IncomingMessage, fallbackHost: string): ForwardTarget {
	const rawUrl = req.url || "/";
	const host = String(req.headers.host || fallbackHost);
	const parsed = rawUrl.startsWith("http://") || rawUrl.startsWith("https://")
		? new URL(rawUrl)
		: new URL(`https://${host}${rawUrl}`);
	return urlToTarget(parsed);
}

/** Convert a parsed URL into upstream request coordinates. */
function urlToTarget(parsed: URL): ForwardTarget {
	const protocol = parsed.protocol === "http:" ? "http:" : "https:";
	const port = parsed.port ? Number(parsed.port) : protocol === "http:" ? 80 : 443;
	return {
		protocol,
		hostname: parsed.hostname,
		port,
		path: `${parsed.pathname || "/"}${parsed.search || ""}`,
		fullUrl: parsed.toString(),
	};
}

/** Build upstream headers by removing proxy-only hop-by-hop values. */
function buildUpstreamHeaders(headers: IncomingHttpHeaders, target: ForwardTarget): IncomingHttpHeaders {
	const upstreamHeaders: IncomingHttpHeaders = {};
	for (const [key, value] of Object.entries(headers)) {
		if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
			upstreamHeaders[key] = value;
		}
	}
	upstreamHeaders.host = target.port === (target.protocol === "http:" ? 80 : 443)
		? target.hostname
		: `${target.hostname}:${target.port}`;
	return upstreamHeaders;
}
