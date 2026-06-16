/**
 * @file forward-proxy.test.ts
 *
 * Integration-style unit tests for the standalone `vibe-coding-proxy` forward
 * proxy. These tests exercise plain HTTP absolute-form forwarding and JSONL
 * logging without requiring HTTPS trust-store changes.
 *
 * @see ../src/intercept/forward-proxy.ts
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { ForwardProxyServer } from "../src/intercept/forward-proxy";
import type { RawPair } from "../src/types";

/** Start a loopback HTTP upstream and return its base URL plus close hook. */
async function startJsonUpstream(): Promise<{ url: string; close: () => Promise<void> }> {
	const server = http.createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer | string) => {
			chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
		});
		req.on("end", () => {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ id: "msg_test", content: [{ type: "text", text: "ok" }] }));
		});
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

/** Send one absolute-form request through the proxy. */
async function postThroughProxy(proxyPort: number, targetUrl: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const req = http.request(
			{
				hostname: "127.0.0.1",
				port: proxyPort,
				method: "POST",
				path: `${targetUrl}/v1/messages`,
				headers: {
					"content-type": "application/json",
				},
			},
			(res) => {
				const chunks: Buffer[] = [];
				res.on("data", (chunk: Buffer | string) => {
					chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
				});
				res.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
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

/** Verifies basic HTTP forward-proxy behavior and log shape. */
describe("ForwardProxyServer", () => {
	/** Plain HTTP requests should be forwarded and logged when target URL matches. */
	it("forwards absolute-form HTTP requests and writes JSONL", async () => {
		const upstream = await startJsonUpstream();
		const logDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-forward-"));
		const proxy = new ForwardProxyServer({
			disableMitm: true,
			targetUrls: [upstream.url],
			logDirectory,
			openBrowser: false,
		});

		const info = await proxy.start();
		const response = await postThroughProxy(info.port, upstream.url);
		const pair = await waitForPair(info.logs.jsonl);

		assert.match(response, /msg_test/);
		assert.equal(pair.request.method, "POST");
		assert.equal(pair.request.url, `${upstream.url}/v1/messages`);
		assert.equal(pair.response?.status_code, 200);

		proxy.stop();
		await upstream.close();
	});
});
