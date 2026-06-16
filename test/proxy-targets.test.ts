/**
 * @file proxy-targets.test.ts
 *
 * Unit tests for target URL and host allowlist matching used by
 * `vibe-coding-proxy`. The matcher controls which CONNECT targets are eligible
 * for MITM and which decrypted request URLs are fully logged.
 *
 * @see ../src/intercept/proxy-targets.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ProxyTargetMatcher, splitHostPort } from "../src/intercept/proxy-targets";

/** Verifies host parsing for CONNECT authorities and target allowlist behavior. */
describe("ProxyTargetMatcher", () => {
	/** CONNECT authorities may include explicit ports. */
	it("splits host and port from CONNECT authority", () => {
		assert.deepEqual(splitHostPort("api.deepseek.com:443"), {
			hostname: "api.deepseek.com",
			port: 443,
		});
	});

	/** A target URL implies both host-level MITM and path-prefix body logging. */
	it("matches target URL prefixes for MITM and logging", () => {
		const matcher = new ProxyTargetMatcher({
			targetUrls: ["https://api.deepseek.com/anthropic"],
		});

		assert.equal(matcher.shouldMitmHost("api.deepseek.com:443"), true);
		assert.equal(matcher.shouldLogUrl("https://api.deepseek.com/anthropic/v1/messages"), true);
		assert.equal(matcher.shouldLogUrl("https://api.deepseek.com/other/v1/messages"), false);
	});

	/** Host-only rules allow all decrypted paths on the host to be logged. */
	it("logs any path for host-only MITM targets", () => {
		const matcher = new ProxyTargetMatcher({
			mitmHosts: ["api.deepseek.com"],
		});

		assert.equal(matcher.shouldMitmHost("api.deepseek.com:443"), true);
		assert.equal(matcher.shouldLogUrl("https://api.deepseek.com/v1/chat/completions"), true);
	});
});
