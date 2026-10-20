/**
 * @file reverse-proxy-zstd.test.ts
 *
 * Regression test for logging zstd-compressed SSE responses from the reverse proxy.
 * OpenCode 1.19+ sends `accept-encoding: zstd`, and providers such as DeepSeek return
 * Anthropic message streams with `content-encoding: zstd`. The proxy must decompress
 * a copy for the JSONL log while still forwarding the original compressed bytes.
 *
 * Skipped on Node versions without `zlib.zstdCompressSync` (Node 20 CI). The runtime
 * path stores a placeholder instead of crashing when zstd is unavailable.
 *
 * @see ../src/intercept/reverse-proxy.ts — `decodeResponseBodyForLog`
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { describe, it } from "node:test";
import { ReverseProxyServer } from "../src/intercept/reverse-proxy";
import type { RawPair } from "../src/types";

/** zlib plus optional zstd helpers present on Node 22.15+ / 24. */
type ZlibWithZstd = typeof zlib & {
	zstdCompressSync?: (buffer: Buffer) => Buffer;
	zstdDecompressSync?: (buffer: Buffer) => Buffer;
};

const zlibWithZstd = zlib as ZlibWithZstd;
const hasZstd =
	typeof zlibWithZstd.zstdCompressSync === "function" &&
	typeof zlibWithZstd.zstdDecompressSync === "function";

/** Minimal Anthropic SSE stream whose reconstructed text is stable. */
const SSE_BODY = [
	'event: message_start',
	'data: {"type":"message_start","message":{"id":"msg_zstd","type":"message","role":"assistant","content":[],"model":"test-model","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":1}}}',
	"",
	"event: content_block_start",
	'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
	"",
	"event: content_block_delta",
	'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello from zstd"}}',
	"",
	"event: content_block_stop",
	'data: {"type":"content_block_stop","index":0}',
	"",
	"event: message_delta",
	'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":3}}',
	"",
	"event: message_stop",
	'data: {"type":"message_stop"}',
	"",
].join("\n");

/** Start a loopback upstream that returns the fixture SSE compressed with zstd. */
async function startZstdSseUpstream(): Promise<{ url: string; close: () => Promise<void> }> {
	const compressed = zlibWithZstd.zstdCompressSync!(Buffer.from(SSE_BODY, "utf-8"));
	const server = http.createServer((_req, res) => {
		res.writeHead(200, {
			"content-type": "text/event-stream; charset=utf-8",
			"content-encoding": "zstd",
			"content-length": String(compressed.length),
		});
		res.end(compressed);
	});

	await new Promise<void>((resolve) => {
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	assert.equal(typeof address, "object");
	assert.ok(address);
	return {
		url: `http://127.0.0.1:${address.port}`,
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}

/** POST `/v1/messages` through the reverse proxy and return the raw response bytes. */
async function postThroughProxy(proxyPort: number): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
	return new Promise((resolve, reject) => {
		const req = http.request(
			{
				hostname: "127.0.0.1",
				port: proxyPort,
				method: "POST",
				path: "/v1/messages",
				headers: {
					"content-type": "application/json",
					"accept-encoding": "gzip, deflate, br, zstd",
				},
			},
			(res) => {
				const chunks: Buffer[] = [];
				res.on("data", (chunk: Buffer | string) => {
					chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
				});
				res.on("end", () =>
					resolve({
						status: res.statusCode || 0,
						headers: res.headers,
						body: Buffer.concat(chunks),
					}),
				);
			},
		);
		req.on("error", reject);
		req.write(JSON.stringify({ model: "test-model", messages: [{ role: "user", content: "hi" }] }));
		req.end();
	});
}

/** Wait until the async logger has written at least one JSONL pair. */
async function waitForPair(jsonlPath: string): Promise<RawPair> {
	for (let attempt = 0; attempt < 40; attempt++) {
		if (fs.existsSync(jsonlPath)) {
			const content = fs.readFileSync(jsonlPath, "utf-8").trim();
			if (content) {
				return JSON.parse(content.split("\n")[0]) as RawPair;
			}
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error("Timed out waiting for JSONL pair");
}

/**
 * Verifies zstd SSE responses are decompressed into assistant text in the log
 * while the client still receives the compressed payload.
 */
describe("ReverseProxyServer zstd responses", () => {
	it("logs decompressed Anthropic SSE text and forwards compressed bytes", { skip: !hasZstd }, async () => {
		const upstream = await startZstdSseUpstream();
		const logDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "claude-trace-zstd-"));
		const proxy = new ReverseProxyServer({
			targetBaseUrl: upstream.url,
			logDirectory,
			logBaseName: "zstd",
			openBrowser: false,
		});

		const info = await proxy.start();
		const response = await postThroughProxy(info.port);
		const pair = await waitForPair(path.join(logDirectory, "zstd.jsonl"));

		assert.equal(response.status, 200);
		assert.equal(response.headers["content-encoding"], "zstd");
		assert.equal(zlibWithZstd.zstdDecompressSync!(response.body).toString("utf-8"), SSE_BODY);

		const message = pair.response?.body as { content?: Array<{ type?: string; text?: string }> };
		assert.equal(message.content?.[0]?.text, "Hello from zstd");
		assert.ok((pair.response?.events?.length ?? 0) > 0);

		proxy.stop();
		await upstream.close();
	});
});
