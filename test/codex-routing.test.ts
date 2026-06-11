/**
 * @file codex-routing.test.ts
 *
 * Unit tests for Codex CLI proxy routing and config overlay integration.
 *
 * Codex CLI always runs in reverse-proxy mode: claude-trace reads the user's
 * `$CODEX_HOME/config.toml`, builds a persistent overlay that rewrites all
 * `*_base_url` values to the local proxy, and routes incoming HTTP requests to
 * the correct upstream host based on path prefixes (OpenAI API Key vs ChatGPT
 * OAuth vs custom `model_providers`).
 *
 * This suite exercises:
 * - Route discovery from TOML config (`listRoutesFromCodexConfig`)
 * - Model-id → route lookup (`buildCodexModelRouteMap`)
 * - Path-based upstream host selection (`resolveCodexRouteTarget`)
 * - Overlay rewriting of base URLs to the local proxy (`syncCodexConfigOverlay`)
 * - Graceful handling of missing config files (`readCodexConfig`)
 *
 * @see ../src/codex-routing.ts — path-based upstream resolution
 * @see ../src/codex-config-overlay.ts — CODEX_HOME overlay sync
 * @see ../src/tools/codex.ts — route listing and model map construction
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { resolveCodexRouteTarget } from "../src/routing/codex-routing";
import {
	listRoutesFromCodexConfig,
	buildCodexModelRouteMap,
	type CodexConfig,
} from "../src/tools/codex";
import { readCodexConfig, syncCodexConfigOverlay, isChatGptAuthMode } from "../src/config/codex-config-overlay";
import { parse, stringify } from "smol-toml";

/**
 * Verifies which upstream routes are registered from Codex `config.toml` fields.
 *
 * Route entries drive both path-prefix matching and model-based fallback in
 * the Codex reverse proxy.
 */
describe("listRoutesFromCodexConfig", () => {
	/** Isolated CODEX_HOME path used to avoid reading the real user home directory. */
	const isolatedHome = path.join(os.tmpdir(), "codex-routing-test-home");

	/**
	 * Every Codex config should expose at least the default OpenAI API Key route
	 * when `openai_base_url` and `model_provider: "openai"` are present.
	 */
	it("includes openai route by default", () => {
		const routes = listRoutesFromCodexConfig(
			{ openai_base_url: "https://api.openai.com/v1", model_provider: "openai" },
			isolatedHome,
		);
		assert.ok(routes.some((route) => route.id === "openai"));
		assert.equal(routes.find((route) => route.id === "openai")?.upstreamBaseUrl, "https://api.openai.com/v1");
	});

	/**
	 * The ChatGPT OAuth route is optional and only registered when
	 * `chatgpt_base_url` is set in config.
	 */
	it("includes chatgpt route when chatgpt_base_url is set", () => {
		const routes = listRoutesFromCodexConfig(
			{
				chatgpt_base_url: "https://chatgpt.example.com/backend-api/codex",
			},
			isolatedHome,
		);
		const chatgpt = routes.find((route) => route.id === "chatgpt");
		assert.ok(chatgpt);
		assert.equal(chatgpt?.upstreamBaseUrl, "https://chatgpt.example.com/backend-api/codex");
		assert.deepEqual(chatgpt?.matchPathPrefixes, ["/backend-api/codex"]);
	});

	/**
	 * User-defined `model_providers.*` entries with a `base_url` become
	 * routable upstream targets keyed by provider id.
	 */
	it("includes custom model provider routes", () => {
		const routes = listRoutesFromCodexConfig({
			model_provider: "myproxy",
			model_providers: {
				myproxy: {
					name: "My Proxy",
					base_url: "https://proxy.example.com/v1",
				},
			},
		});
		const custom = routes.find((route) => route.id === "myproxy");
		assert.ok(custom);
		assert.equal(custom?.upstreamBaseUrl, "https://proxy.example.com/v1");
	});

	/**
	 * Builtin providers such as `ollama` must not be overridden via
	 * `model_providers`; those entries are skipped during route discovery.
	 */
	it("skips reserved builtin provider overrides", () => {
		const routes = listRoutesFromCodexConfig({
			model_providers: {
				ollama: {
					base_url: "http://localhost:11434/v1",
				},
			},
		});
		assert.equal(routes.find((route) => route.id === "ollama"), undefined);
	});

	/**
	 * When `auth.json` sets `auth_mode: "chatgpt"`, OpenAI routes must not be
	 * registered even if `OPENAI_BASE_URL` is set for other tools in the shell.
	 */
	it("excludes openai route when auth_mode is chatgpt", () => {
		const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-auth-home-"));
		fs.writeFileSync(
			path.join(tmpHome, "auth.json"),
			JSON.stringify({ auth_mode: "chatgpt", OPENAI_API_KEY: null }),
		);

		const previousBaseUrl = process.env.OPENAI_BASE_URL;
		process.env.OPENAI_BASE_URL = "https://api.fe8.cn";

		try {
			const routes = listRoutesFromCodexConfig({}, tmpHome);
			assert.equal(routes.find((route) => route.id === "openai"), undefined);
			assert.ok(routes.find((route) => route.id === "chatgpt"));
			assert.deepEqual(routes.find((route) => route.id === "chatgpt")?.matchPathPrefixes, [
				"/backend-api/codex",
				"/v1/responses",
				"/responses",
			]);
		} finally {
			if (previousBaseUrl === undefined) {
				delete process.env.OPENAI_BASE_URL;
			} else {
				process.env.OPENAI_BASE_URL = previousBaseUrl;
			}
			fs.rmSync(tmpHome, { recursive: true, force: true });
		}
	});

	/**
	 * ChatGPT OAuth should register a separate wham route for the built-in `codex_apps` MCP.
	 */
	it("includes chatgpt apps mcp routes when chatgpt auth is active", () => {
		const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-auth-home-"));
		fs.writeFileSync(
			path.join(tmpHome, "auth.json"),
			JSON.stringify({ auth_mode: "chatgpt", OPENAI_API_KEY: null }),
		);

		try {
			const routes = listRoutesFromCodexConfig({}, tmpHome);
			const wham = routes.find((route) => route.id === "chatgpt-wham");
			assert.ok(wham);
			assert.equal(wham?.upstreamBaseUrl, "https://chatgpt.com");
			assert.deepEqual(wham?.matchPathPrefixes, ["/backend-api/wham"]);

			const appsMcp = routes.find((route) => route.id === "chatgpt-apps-mcp");
			assert.ok(appsMcp);
			assert.equal(appsMcp?.upstreamBaseUrl, "https://chatgpt.com");
			assert.deepEqual(appsMcp?.matchPathPrefixes, ["/api/codex/apps"]);
			assert.equal(appsMcp?.fixedUpstreamPath, "/backend-api/wham/apps");
		} finally {
			fs.rmSync(tmpHome, { recursive: true, force: true });
		}
	});
});

/**
 * Tests the model-id → route lookup table used by the Codex reverse proxy
 * when resolving which upstream host and API format apply to a request body.
 */
describe("buildCodexModelRouteMap", () => {
	/**
	 * The active `model` and `model_provider` fields should resolve to an
	 * OpenAI Responses format route pointing at the configured upstream base URL.
	 */
	it("maps configured model to active provider", () => {
		const map = buildCodexModelRouteMap(
			{
				model: "gpt-5-codex",
				model_provider: "openai",
				openai_base_url: "https://api.openai.com/v1",
			},
			path.join(os.tmpdir(), "codex-routing-test-home"),
		);
		assert.equal(map["gpt-5-codex"]?.apiFormat, "openai-responses");
		assert.equal(map["gpt-5-codex"]?.upstreamBaseUrl, "https://api.openai.com/v1");
		assert.equal(map["openai/*"]?.isProviderFallback, true);
	});
});

/**
 * Tests HTTP path prefix matching to select OpenAI vs ChatGPT upstream hosts.
 *
 * Codex may authenticate via OpenAI API Key (`/v1/responses`) or ChatGPT OAuth
 * (`/backend-api/codex/responses`); the proxy must route each to the correct host.
 */
describe("resolveCodexRouteTarget", () => {
	/** Default fallback target when no configured route prefix matches the request path. */
	const fallback = {
		protocol: "https:",
		targetHost: "api.openai.com",
		targetPort: 443,
		pathPrefix: "/v1",
	};

	/**
	 * Requests to `/v1/responses` should target the OpenAI upstream base URL
	 * and preserve the full display path for logging.
	 */
	it("routes openai responses path to openai upstream", () => {
		const target = resolveCodexRouteTarget(
			"/v1/responses",
			[
				{
					id: "openai",
					upstreamBaseUrl: "https://api.openai.com/v1",
					matchPathPrefixes: ["/v1/responses", "/responses"],
				},
				{
					id: "chatgpt",
					upstreamBaseUrl: "https://chatgpt.com/backend-api/codex",
					matchPathPrefixes: ["/backend-api/codex"],
				},
			],
			fallback,
		);
		assert.equal(target.targetHost, "api.openai.com");
		assert.equal(target.upstreamDisplayPath, "/v1/responses");
	});

	/**
	 * ChatGPT OAuth paths under `/backend-api/codex` should route to the
	 * ChatGPT host rather than the OpenAI API host.
	 */
	it("routes chatgpt path to chatgpt upstream", () => {
		const target = resolveCodexRouteTarget(
			"/backend-api/codex/responses",
			[
				{
					id: "openai",
					upstreamBaseUrl: "https://api.openai.com/v1",
					matchPathPrefixes: ["/v1/responses", "/responses"],
				},
				{
					id: "chatgpt",
					upstreamBaseUrl: "https://chatgpt.com/backend-api/codex",
					matchPathPrefixes: ["/backend-api/codex"],
				},
			],
			fallback,
		);
		assert.equal(target.targetHost, "chatgpt.com");
		assert.equal(target.upstreamDisplayPath, "/backend-api/codex/responses");
	});

	/**
	 * ChatGPT OAuth sessions may POST to `/responses` against the proxy base URL;
	 * when only the ChatGPT route is registered, that path should still reach ChatGPT upstream.
	 */
	it("routes chatgpt /responses path when openai route is absent", () => {
		const target = resolveCodexRouteTarget(
			"/responses",
			[
				{
					id: "chatgpt",
					upstreamBaseUrl: "https://chatgpt.com/backend-api/codex",
					matchPathPrefixes: ["/backend-api/codex", "/v1/responses", "/responses"],
				},
			],
			fallback,
		);
		assert.equal(target.targetHost, "chatgpt.com");
		assert.equal(target.upstreamDisplayPath, "/backend-api/codex/responses");
	});

	/**
	 * Built-in `codex_apps` MCP posts to `/backend-api/wham/apps` on the ChatGPT host.
	 * The path must not be prefixed with `/backend-api/codex` when forwarded upstream.
	 */
	it("routes chatgpt wham/apps path to chatgpt site origin", () => {
		const target = resolveCodexRouteTarget(
			"/backend-api/wham/apps",
			[
				{
					id: "chatgpt",
					upstreamBaseUrl: "https://chatgpt.com/backend-api/codex",
					matchPathPrefixes: ["/backend-api/codex", "/v1/responses", "/responses"],
				},
				{
					id: "chatgpt-wham",
					upstreamBaseUrl: "https://chatgpt.com",
					matchPathPrefixes: ["/backend-api/wham"],
				},
			],
			fallback,
		);
		assert.equal(target.targetHost, "chatgpt.com");
		assert.equal(target.upstreamDisplayPath, "/backend-api/wham/apps");
	});

	/**
	 * When the overlay rewrites `chatgpt_base_url` to a bare proxy URL, Codex builds
	 * MCP requests to `/api/codex/apps` — remap to the canonical wham upstream path.
	 */
	it("remaps proxy /api/codex/apps to chatgpt wham/apps upstream", () => {
		const target = resolveCodexRouteTarget(
			"/api/codex/apps",
			[
				{
					id: "chatgpt",
					upstreamBaseUrl: "https://chatgpt.com/backend-api/codex",
					matchPathPrefixes: ["/backend-api/codex", "/v1/responses", "/responses"],
				},
				{
					id: "chatgpt-apps-mcp",
					upstreamBaseUrl: "https://chatgpt.com",
					matchPathPrefixes: ["/api/codex/apps"],
					fixedUpstreamPath: "/backend-api/wham/apps",
				},
			],
			fallback,
		);
		assert.equal(target.targetHost, "chatgpt.com");
		assert.equal(target.upstreamDisplayPath, "/backend-api/wham/apps");
	});
});

/**
 * Tests the persistent CODEX_HOME overlay that redirects all base URLs to the
 * local reverse proxy without modifying the user's original config directory.
 */
describe("syncCodexConfigOverlay", () => {
	/**
	 * All `*_base_url` keys and custom `model_providers.*.base_url` values
	 * should be rewritten to the proxy URL. WebSocket support is disabled in
	 * the overlay for MVP logging compatibility.
	 */
	it("rewrites base_url keys to proxy URL", () => {
		const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
		const overlayDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-overlay-"));

		const config: CodexConfig = {
			model: "gpt-5-codex",
			openai_base_url: "https://api.openai.com/v1",
			chatgpt_base_url: "https://chatgpt.com/backend-api/codex",
			model_providers: {
				myproxy: {
					base_url: "https://proxy.example.com/v1",
					supports_websockets: true,
				},
			},
		};

		fs.writeFileSync(path.join(tmpHome, "config.toml"), stringify(config));

		syncCodexConfigOverlay(tmpHome, overlayDir, "http://127.0.0.1:9999");

		const overlayConfig = parse(fs.readFileSync(path.join(overlayDir, "config.toml"), "utf-8")) as CodexConfig;
		assert.equal(overlayConfig.openai_base_url, "http://127.0.0.1:9999");
		assert.equal(overlayConfig.chatgpt_base_url, "http://127.0.0.1:9999");
		assert.equal(overlayConfig.model_providers?.myproxy?.base_url, "http://127.0.0.1:9999");
		assert.equal(overlayConfig.model_providers?.myproxy?.supports_websockets, false);

		fs.rmSync(tmpHome, { recursive: true, force: true });
		fs.rmSync(overlayDir, { recursive: true, force: true });
	});
});

/**
 * Tests reading Codex config from disk when CODEX_HOME is unset, empty, or
 * missing a `config.toml` file.
 */
describe("readCodexConfig", () => {
	/**
	 * A missing `config.toml` should yield an empty config object rather than
	 * throwing, allowing the proxy to start with sensible defaults.
	 */
	it("returns empty config when file is missing", () => {
		const missingHome = path.join(os.tmpdir(), "codex-missing-" + Date.now());
		assert.deepEqual(readCodexConfig(missingHome), {});
	});
});

/**
 * Tests parsing `auth.json` auth_mode for ChatGPT OAuth vs API-key routing.
 */
describe("isChatGptAuthMode", () => {
	it("returns true when auth_mode is chatgpt", () => {
		const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-auth-mode-"));
		fs.writeFileSync(path.join(tmpHome, "auth.json"), JSON.stringify({ auth_mode: "chatgpt" }));
		assert.equal(isChatGptAuthMode(tmpHome), true);
		fs.rmSync(tmpHome, { recursive: true, force: true });
	});

	it("returns false when auth_mode is absent", () => {
		const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-auth-mode-"));
		fs.writeFileSync(
			path.join(tmpHome, "auth.json"),
			JSON.stringify({ OPENAI_API_KEY: "sk-test", tokens: { chatgpt: true } }),
		);
		assert.equal(isChatGptAuthMode(tmpHome), false);
		fs.rmSync(tmpHome, { recursive: true, force: true });
	});
});
