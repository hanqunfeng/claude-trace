import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildModelRouteMap, inferApiFormat } from "../src/tools/opencode";
import { resolveModelRoute } from "../src/proxy-routing";

describe("inferApiFormat", () => {
	it("detects anthropic npm package", () => {
		assert.equal(inferApiFormat("@ai-sdk/anthropic"), "anthropic");
	});

	it("detects openai-compatible npm package", () => {
		assert.equal(inferApiFormat("@ai-sdk/openai-compatible"), "openai");
	});

	it("detects openai responses npm package", () => {
		assert.equal(inferApiFormat("@ai-sdk/openai"), "openai-responses");
	});
});

describe("buildModelRouteMap", () => {
	it("maps explicit models and provider fallback", () => {
		const map = buildModelRouteMap({
			provider: {
				deepseek: {
					npm: "@ai-sdk/openai-compatible",
					options: { baseURL: "https://api.deepseek.com/v1" },
					models: {
						"deepseek-chat": { name: "DeepSeek Chat" },
					},
				},
			},
		});

		assert.equal(map["deepseek-chat"]?.apiFormat, "openai");
		assert.equal(map["deepseek/deepseek-chat"]?.providerId, "deepseek");
		assert.equal(map["deepseek/*"]?.isProviderFallback, true);
	});

	it("supports per-model npm override", () => {
		const map = buildModelRouteMap({
			provider: {
				mixed: {
					npm: "@ai-sdk/openai-compatible",
					options: { baseURL: "https://api.example.com/v1" },
					models: {
						"chat-model": { name: "Chat" },
						"responses-model": { npm: "@ai-sdk/openai", name: "Responses" },
					},
				},
			},
		});

		assert.equal(map["chat-model"]?.apiFormat, "openai");
		assert.equal(map["responses-model"]?.apiFormat, "openai-responses");
	});

	it("registers provider fallback when no models declared", () => {
		const map = buildModelRouteMap({
			provider: {
				openai: {
					npm: "@ai-sdk/openai-compatible",
					options: { baseURL: "https://api.custom.com/v1" },
				},
			},
		});

		assert.equal(map["openai/*"]?.apiFormat, "openai");
		assert.equal(map["openai/*"]?.upstreamBaseUrl, "https://api.custom.com/v1");
	});
});

describe("resolveModelRoute", () => {
	const modelRoutes = buildModelRouteMap({
		provider: {
			apiyi: {
				npm: "@ai-sdk/openai-compatible",
				options: { baseURL: "https://api.apiyi.com/v1" },
				models: {
					"gpt-4.1": { name: "GPT-4.1" },
				},
			},
		},
	});

	it("matches provider/model exact key", () => {
		const route = resolveModelRoute("apiyi/gpt-4.1", modelRoutes);
		assert.equal(route?.providerId, "apiyi");
		assert.equal(route?.apiFormat, "openai");
	});

	it("falls back to provider prefix for unknown model id", () => {
		const route = resolveModelRoute("apiyi/unknown-model", modelRoutes);
		assert.equal(route?.providerId, "apiyi");
		assert.equal(route?.modelId, "unknown-model");
	});
});
