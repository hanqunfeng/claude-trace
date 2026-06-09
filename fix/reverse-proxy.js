"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ReverseProxyServer = void 0;
const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const html_generator_1 = require("./html-generator");
const shared_conversation_processor_1 = require("./shared-conversation-processor");

function parseTargetBaseUrl(targetBaseUrl) {
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

class ReverseProxyServer {
    constructor(config = {}) {
        this.server = null;
        this.pairs = [];
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
        const fileBaseName = this.config.logBaseName ||
            `log-${new Date().toISOString().replace(/[:.]/g, "-").replace("T", "-").slice(0, -5)}`;
        this.logFile = path.join(this.config.logDirectory, `${fileBaseName}.jsonl`);
        this.jsonFile = path.join(this.config.logDirectory, `${fileBaseName}.json`);
        this.htmlFile = path.join(this.config.logDirectory, `${fileBaseName}.html`);
        fs.writeFileSync(this.logFile, "");
        fs.writeFileSync(this.jsonFile, "[]");
        this.htmlGenerator = new html_generator_1.HTMLGenerator();
    }

    processHeaders(headers) {
        const result = {};
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

    parseSSEEvents(body) {
        const events = [];
        const lines = body.split("\n");
        let currentEvent = "";
        for (const line of lines) {
            if (line.startsWith("event: ")) {
                currentEvent = line.substring(7).trim();
            } else if (line.startsWith("data: ")) {
                const data = line.substring(6).trim();
                if (data === "[DONE]") break;
                try {
                    const parsed = JSON.parse(data);
                    events.push({
                        event: currentEvent || parsed?.type || "unknown",
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

    async writePairToLog(pair) {
        try {
            const jsonLine = JSON.stringify(pair) + "\n";
            fs.appendFileSync(this.logFile, jsonLine);
            fs.writeFileSync(this.jsonFile, JSON.stringify(this.pairs, null, 2));
        } catch (err) {
            console.error(`Failed to write log: ${err}`);
        }
    }

    async generateHTML() {
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

    async start() {
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

    handleRequest(req, res) {
        const requestTimestamp = Date.now();
        let requestBody = "";
        req.on("data", (chunk) => {
            requestBody += chunk;
        });
        req.on("end", () => {
            const upstreamPath = `${this.pathPrefix}${req.url || "/"}`;
            const upstreamUrl = `${this.targetProtocol}//${this.targetHost}${upstreamPath}`;
            const options = {
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
                const responseChunks = [];
                // Forward response headers first
                res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
                proxyRes.on("data", (chunk) => {
                    responseChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
                    res.write(chunk);
                });
                proxyRes.on("end", async () => {
                    res.end();
                    const url = upstreamUrl;
                    const shouldLog = this.config.includeAllRequests || (req.url && req.url.includes("/v1/messages"));
                    if (shouldLog) {
                        let parsedRequestBody = null;
                        try {
                            parsedRequestBody = requestBody ? JSON.parse(requestBody) : null;
                        } catch {
                            parsedRequestBody = requestBody || null;
                        }
                        const rawBuffer = Buffer.concat(responseChunks);
                        let responseBody;
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
                        let parsedResponseBody = {};
                        const contentType = proxyRes.headers["content-type"] || "";
                        try {
                            if (contentType.includes("application/json")) {
                                parsedResponseBody = { body: JSON.parse(responseBody) };
                            } else if (contentType.includes("text/event-stream")) {
                                const events = this.parseSSEEvents(responseBody);
                                const processor = new shared_conversation_processor_1.SharedConversationProcessor();
                                try {
                                    const message = processor.parseStreamingResponse(responseBody);
                                    parsedResponseBody = { body: message, events };
                                } catch {
                                    parsedResponseBody = { body_raw: responseBody, events };
                                }
                            } else {
                                parsedResponseBody = { body_raw: responseBody };
                            }
                        } catch {
                            parsedResponseBody = { body_raw: responseBody };
                        }
                        const pair = {
                            request: {
                                timestamp: requestTimestamp / 1000,
                                method: req.method || "GET",
                                url: url,
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
                        await this.writePairToLog(pair);
                        await this.generateHTML();
                    }
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

    stop() {
        if (this.server) {
            console.log(`Logged ${this.pairs.length} request/response pairs`);
            if (this.config.openBrowser && fs.existsSync(this.htmlFile)) {
                try {
                    const { spawn } = require("child_process");
                    const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
                    if (process.platform === "win32") {
                        spawn("cmd", ["/c", "start", "", this.htmlFile], { detached: true, stdio: "ignore" }).unref();
                    } else {
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
}

exports.ReverseProxyServer = ReverseProxyServer;