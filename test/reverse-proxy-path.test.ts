import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeUpstreamPath } from "../src/proxy-routing";
import type { ModelRoute } from "../src/tools/types";

describe("normalizeUpstreamPath", () => {
	const openaiRoute: ModelRoute = {
		providerId: "apiyi",
		modelId: "gpt-4.1",
		upstreamBaseUrl: "https://api.apiyi.com/v1",
		npm: "@ai-sdk/openai-compatible",
		apiFormat: "openai",
	};

	it("strips duplicate /v1 prefix for openai routes", () => {
		const normalized = normalizeUpstreamPath("/v1/chat/completions", openaiRoute, "/v1");
		assert.equal(normalized, "/chat/completions");
	});

	it("keeps /chat/completions when path has no duplicate prefix", () => {
		const normalized = normalizeUpstreamPath("/chat/completions", openaiRoute, "/v1");
		assert.equal(normalized, "/chat/completions");
	});

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
