/**
 * @file opencode-routing.test.ts
 *
 * Unit tests for OpenCode provider routing used by the reverse proxy.
 *
 * OpenCode always runs in reverse-proxy mode. At startup, claude-trace reads
 * the user's `opencode.json` (or env overrides), builds a model-id lookup table,
 * and uses it to resolve each intercepted request to an upstream base URL and
 * API format (Anthropic Messages vs OpenAI Chat vs OpenAI Responses).
 *
 * This suite covers:
 * - npm-package → API format inference (`inferApiFormat`)
 * - Model route map construction from config (`buildModelRouteMap`)
 * - Runtime model string resolution (`resolveModelRoute`)
 *
 * @see ../src/tools/opencode.ts — OpenCode config parsing and route map building
 * @see ../src/proxy-routing.ts — `resolveModelRoute` and upstream path normalization
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildModelRouteMap, inferApiFormat } from "../src/tools/opencode";
import { resolveModelRoute } from "../src/routing/proxy-routing";

/**
 * Tests mapping from `@ai-sdk/*` npm package names to internal API format enums.
 *
 * The npm package declared on a provider (or per-model override) determines
 * which request/response adapter the reverse proxy applies.
 */
describe("inferApiFormat", () => {
	/** `@ai-sdk/anthropic` providers use the Anthropic Messages API format. */
	it("detects anthropic npm package", () => {
		assert.equal(inferApiFormat("@ai-sdk/anthropic"), "anthropic");
	});

	/** `@ai-sdk/openai-compatible` providers use OpenAI Chat Completions format. */
	it("detects openai-compatible npm package", () => {
		assert.equal(inferApiFormat("@ai-sdk/openai-compatible"), "openai");
	});

	/** `@ai-sdk/openai` providers use the OpenAI Responses API format. */
	it("detects openai responses npm package", () => {
		assert.equal(inferApiFormat("@ai-sdk/openai"), "openai-responses");
	});
});

/**
 * Tests construction of provider/model → route entries from OpenCode config.
 *
 * The route map keys include bare model ids, `provider/model` compound keys,
 * and `provider/*` wildcard fallbacks for unknown models under a provider.
 */
describe("buildModelRouteMap", () => {
	/**
	 * Explicit model entries and a `provider/*` fallback key should both be
	 * registered with the correct upstream base URL and API format.
	 */
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

	/**
	 * Individual models may override the provider-level npm package, allowing
	 * mixed Chat Completions and Responses models under one provider.
	 */
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

	/**
	 * Providers with no declared models should still receive a wildcard fallback
	 * route so unknown model ids can be routed to the provider's base URL.
	 */
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

/**
 * Tests runtime model string resolution against the pre-built route map.
 *
 * OpenCode sends model identifiers as `provider/model`; resolution must match
 * exact keys first, then fall back to provider wildcards.
 */
describe("resolveModelRoute", () => {
	/** Shared route map fixture for exact-match and fallback scenarios below. */
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

	/**
	 * A `provider/model` string that matches an explicitly configured model
	 * entry should resolve to that provider's route and API format.
	 */
	it("matches provider/model exact key", () => {
		const route = resolveModelRoute("apiyi/gpt-4.1", modelRoutes);
		assert.equal(route?.providerId, "apiyi");
		assert.equal(route?.apiFormat, "openai");
	});

	/**
	 * Unknown model ids under a known provider should resolve via the
	 * `provider/*` fallback route while preserving the requested model id.
	 */
	it("falls back to provider prefix for unknown model id", () => {
		const route = resolveModelRoute("apiyi/unknown-model", modelRoutes);
		assert.equal(route?.providerId, "apiyi");
		assert.equal(route?.modelId, "unknown-model");
	});
});
