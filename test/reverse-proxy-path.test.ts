/**
 * @file reverse-proxy-path.test.ts
 *
 * Unit tests for upstream path normalization used by the reverse proxy when
 * forwarding intercepted API requests to provider-specific upstream hosts.
 *
 * The reverse proxy receives HTTP requests from native CLI binaries (Claude Code
 * V2+, OpenCode, Codex) that may use client-specific path conventions. Before
 * forwarding, `normalizeUpstreamPath` (from `proxy-routing.ts`) rewrites the
 * request path according to the resolved {@link ModelRoute}'s `apiFormat` and
 * the upstream base URL's path prefix, avoiding duplicated segments such as
 * `/v1/v1/chat/completions` or missing version prefixes on Anthropic routes.
 *
 * @see ../src/proxy-routing.ts — `normalizeUpstreamPath`
 * @see ../src/reverse-proxy.ts — consumer of path normalization during proxy forwarding
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeUpstreamPath } from "../src/proxy-routing";
import type { ModelRoute } from "../src/tools/types";

/**
 * Tests path rewriting rules for OpenAI-compatible and Anthropic model routes.
 *
 * Each case verifies that a client-supplied path and upstream prefix combine
 * into the correct final upstream request path.
 */
describe("normalizeUpstreamPath", () => {
	/** Representative OpenAI-compatible route whose upstream base URL includes `/v1`. */
	const openaiRoute: ModelRoute = {
		providerId: "apiyi",
		modelId: "gpt-4.1",
		upstreamBaseUrl: "https://api.apiyi.com/v1",
		npm: "@ai-sdk/openai-compatible",
		apiFormat: "openai",
	};

	/**
	 * When the upstream base URL already ends with `/v1`, client paths that also
	 * start with `/v1` must have the duplicate prefix stripped to prevent
	 * `/v1/v1/chat/completions` upstream URLs.
	 */
	it("strips duplicate /v1 prefix for openai routes", () => {
		const normalized = normalizeUpstreamPath("/v1/chat/completions", openaiRoute, "/v1");
		assert.equal(normalized, "/chat/completions");
	});

	/**
	 * Paths that already omit the duplicate `/v1` prefix should pass through
	 * unchanged after normalization.
	 */
	it("keeps /chat/completions when path has no duplicate prefix", () => {
		const normalized = normalizeUpstreamPath("/chat/completions", openaiRoute, "/v1");
		assert.equal(normalized, "/chat/completions");
	});

	/**
	 * Anthropic SDK clients typically POST to `/messages`, but many upstream
	 * gateways expect the versioned path `/v1/messages`. Normalization should
	 * prepend `/v1` when the route uses `apiFormat: "anthropic"`.
	 */
	it("normalizes anthropic /messages to /v1/messages", () => {
		const anthropicRoute: ModelRoute = {
			providerId: "anthropic",
			modelId: "claude-sonnet-4",
			upstreamBaseUrl: "https://api.anthropic.com",
			npm: "@ai-sdk/anthropic",
			apiFormat: "anthropic",
		};
		const normalized = normalizeUpstreamPath("/messages", anthropicRoute, "");
		assert.equal(normalized, "/v1/messages");
	});
});
