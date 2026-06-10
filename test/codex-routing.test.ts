import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { resolveCodexRouteTarget } from "../src/codex-routing";
import {
	listRoutesFromCodexConfig,
	buildCodexModelRouteMap,
	type CodexConfig,
} from "../src/tools/codex";
import { readCodexConfig, syncCodexConfigOverlay } from "../src/codex-config-overlay";
import { parse, stringify } from "smol-toml";

describe("listRoutesFromCodexConfig", () => {
	const isolatedHome = path.join(os.tmpdir(), "codex-routing-test-home");

	it("includes openai route by default", () => {
		const routes = listRoutesFromCodexConfig(
			{ openai_base_url: "https://api.openai.com/v1", model_provider: "openai" },
			isolatedHome,
		);
		assert.ok(routes.some((route) => route.id === "openai"));
		assert.equal(routes.find((route) => route.id === "openai")?.upstreamBaseUrl, "https://api.openai.com/v1");
	});

	it("includes chatgpt route when chatgpt_base_url is set", () => {
		const routes = listRoutesFromCodexConfig({
			chatgpt_base_url: "https://chatgpt.example.com/backend-api/codex",
		});
		const chatgpt = routes.find((route) => route.id === "chatgpt");
		assert.ok(chatgpt);
		assert.equal(chatgpt?.upstreamBaseUrl, "https://chatgpt.example.com/backend-api/codex");
		assert.deepEqual(chatgpt?.matchPathPrefixes, ["/backend-api/codex"]);
	});

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
});

describe("buildCodexModelRouteMap", () => {
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

describe("resolveCodexRouteTarget", () => {
	const fallback = {
		protocol: "https:",
		targetHost: "api.openai.com",
		targetPort: 443,
		pathPrefix: "/v1",
	};

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
});

describe("syncCodexConfigOverlay", () => {
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

describe("readCodexConfig", () => {
	it("returns empty config when file is missing", () => {
		const missingHome = path.join(os.tmpdir(), "codex-missing-" + Date.now());
		assert.deepEqual(readCodexConfig(missingHome), {});
	});
});
