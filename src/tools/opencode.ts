/**
 * @file tools/opencode.ts
 * @description Tool profile for OpenCode CLI tracing.
 *
 * This module implements the {@link ToolProfile} interface for OpenCode.
 * Unlike Claude Code, OpenCode **always** uses reverse-proxy interception —
 * there is no Node.js `fetch` hook path.
 *
 * Key responsibilities:
 *
 * - **Binary resolution** — locate `opencode` on PATH with the same
 *   MSYS/alias handling used by the Claude profile.
 * - **Config discovery** — read `opencode.json` following OpenCode's
 *   precedence: `OPENCODE_CONFIG` → `OPENCODE_CONFIG_DIR` → global → project.
 * - **Model-based routing** — build a `Record<string, ModelRoute>` from
 *   configured providers/models so `reverse-proxy.ts` can pick the correct
 *   upstream and API format (`anthropic` vs `openai`) per request.
 * - **Runtime config injection** — set `OPENCODE_CONFIG_CONTENT` with all
 *   provider `baseURL` values rewritten to the local proxy, without touching
 *   the user's on-disk config file.
 *
 * Built-in `models.dev` providers not listed in `opencode.json` are outside
 * the scope of interception; only explicitly configured providers are routed.
 */

import { execSync } from "child_process";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import type { ApiFormat, ModelRoute, ProviderRoute, ToolProfile } from "./types";
import { inferApiFormatFromNpm } from "../api-format";
import { isNativeBinary } from "./binary-utils";
import { log } from "../cli-common";

/** Per-model entry inside an OpenCode provider block. */
interface OpenCodeModelConfig {
	name?: string;
	npm?: string;
	[key: string]: unknown;
}

/** Provider block from `opencode.json` with optional SDK npm hint and base URL. */
interface OpenCodeProviderConfig {
	npm?: string;
	models?: Record<string, OpenCodeModelConfig>;
	options?: {
		baseURL?: string;
		[key: string]: unknown;
	};
	[key: string]: unknown;
}

/** Top-level OpenCode configuration shape (subset used for routing). */
interface OpenCodeConfig {
	provider?: Record<string, OpenCodeProviderConfig>;
	[key: string]: unknown;
}

/**
 * Locate the OpenCode CLI executable on PATH or in common install locations.
 *
 * @param customPath - Optional explicit path from `--opencode-path`.
 * @returns Resolved path to the OpenCode launcher.
 * @throws Exits the process with code 1 if no binary is found.
 */
function findOpenCodePath(customPath?: string): string {
	if (customPath) {
		if (!fs.existsSync(customPath)) {
			log(`OpenCode binary not found at specified path: ${customPath}`, "red");
			process.exit(1);
		}
		return customPath;
	}

	const isWindows = process.platform === "win32";

	try {
		const findCmd = isWindows ? "where.exe opencode" : "which opencode";
		let opencodePath = execSync(findCmd, { encoding: "utf-8" }).trim().split(/\r?\n/)[0];

		// Normalize MSYS/Git Bash drive-letter paths.
		const msysMatch = opencodePath.match(/^\/([a-zA-Z])\//);
		if (msysMatch) {
			opencodePath = msysMatch[1].toUpperCase() + ":/" + opencodePath.slice(3);
		}

		// Expand shell alias output from zsh/fish.
		const aliasMatch = opencodePath.match(/:\s*aliased to\s+(.+)$/);
		if (aliasMatch && aliasMatch[1]) {
			opencodePath = aliasMatch[1];
		}

		return opencodePath;
	} catch {
		const possiblePaths = isWindows
			? [
					path.join(os.homedir(), ".local", "bin", "opencode.exe"),
					path.join(process.env.APPDATA || "", "npm", "opencode.cmd"),
					path.join(process.env.APPDATA || "", "npm", "opencode"),
				]
			: [
					path.join(os.homedir(), ".local", "bin", "opencode"),
					"/opt/homebrew/bin/opencode",
					"/usr/local/bin/opencode",
					"/usr/bin/opencode",
				];

		for (const p of possiblePaths) {
			if (fs.existsSync(p)) {
				return p;
			}
		}

		log(`OpenCode CLI not found in PATH or common locations`, "red");
		log(`Please install OpenCode first: https://opencode.ai`, "red");
		process.exit(1);
	}
}

/**
 * Resolve symlinks to the real OpenCode executable path.
 *
 * @param customPath - Optional explicit path from `--opencode-path`.
 * @returns Canonical binary path.
 */
function getOpenCodeBinaryPath(customPath?: string): string {
	const opencodePath = findOpenCodePath(customPath);

	try {
		return fs.realpathSync(opencodePath);
	} catch {
		return opencodePath;
	}
}

/**
 * Resolve which `opencode.json` file to read, following OpenCode precedence.
 *
 * Order: `OPENCODE_CONFIG` → `OPENCODE_CONFIG_DIR/opencode.json` →
 * `~/.config/opencode/opencode.json` → `.opencode/opencode.json`.
 *
 * @returns Absolute path to config file, or null if none exists.
 */
function resolveOpenCodeConfigPath(): string | null {
	if (process.env.OPENCODE_CONFIG && fs.existsSync(process.env.OPENCODE_CONFIG)) {
		return process.env.OPENCODE_CONFIG;
	}

	if (process.env.OPENCODE_CONFIG_DIR) {
		const configPath = path.join(process.env.OPENCODE_CONFIG_DIR, "opencode.json");
		if (fs.existsSync(configPath)) {
			return configPath;
		}
	}

	const globalConfig = path.join(os.homedir(), ".config", "opencode", "opencode.json");
	if (fs.existsSync(globalConfig)) {
		return globalConfig;
	}

	const projectConfig = path.join(process.cwd(), ".opencode", "opencode.json");
	if (fs.existsSync(projectConfig)) {
		return projectConfig;
	}

	return null;
}

/**
 * Load and parse OpenCode config, returning an empty object on missing/invalid file.
 *
 * @returns Parsed OpenCode config or `{}`.
 */
function readOpenCodeConfig(): OpenCodeConfig {
	const configPath = resolveOpenCodeConfigPath();
	if (!configPath) {
		return {};
	}

	try {
		return JSON.parse(fs.readFileSync(configPath, "utf-8")) as OpenCodeConfig;
	} catch {
		return {};
	}
}

/**
 * Map an OpenCode SDK npm package name to the wire API format.
 *
 * Delegates to `api-format.ts` which recognizes `@ai-sdk/anthropic`,
 * `@ai-sdk/openai`, `@ai-sdk/openai-compatible`, etc.
 *
 * @param npm - Package name from provider/model config (e.g. "@ai-sdk/anthropic").
 * @returns Detected API format for proxy parsing.
 */
function inferApiFormat(npm: string): ApiFormat {
	return inferApiFormatFromNpm(npm);
}

/**
 * Resolve the upstream base URL for a single OpenCode provider.
 *
 * Uses explicit `options.baseURL` when set; falls back to built-in defaults
 * for well-known provider IDs (`anthropic`, `openai`). Providers without a
 * resolvable URL are skipped during route building.
 *
 * @param providerId - Provider key from `opencode.json`.
 * @param provider - Provider configuration block.
 * @returns Upstream base URL or null if the provider cannot be routed.
 */
function resolveProviderBaseUrl(providerId: string, provider: OpenCodeProviderConfig): string | null {
	if (provider?.options?.baseURL) {
		return provider.options.baseURL;
	}
	if (providerId === "anthropic") {
		return process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com";
	}
	if (providerId === "openai") {
		return process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
	}
	return null;
}

/**
 * Build a model-keyed routing map for the reverse proxy.
 *
 * Keys include bare `modelId`, `providerId/modelId`, and `providerId/*`
 * fallback entries. Providers without explicit models get a wildcard-only route.
 * The proxy looks up routes by model name at request time.
 *
 * @param config - Parsed OpenCode configuration.
 * @returns Map from model lookup keys to {@link ModelRoute} entries.
 */
function buildModelRouteMap(config: OpenCodeConfig): Record<string, ModelRoute> {
	const map: Record<string, ModelRoute> = {};

	for (const [providerId, provider] of Object.entries(config.provider || {})) {
		const baseURL = resolveProviderBaseUrl(providerId, provider);
		if (!baseURL) {
			continue;
		}

		const providerNpm = typeof provider.npm === "string" ? provider.npm : "";
		const modelIds = Object.keys(provider.models || {});

		if (modelIds.length === 0) {
			// Provider configured but no per-model entries — route everything via wildcard.
			const apiFormat = inferApiFormat(providerNpm);
			const fallbackRoute: ModelRoute = {
				providerId,
				modelId: "*",
				upstreamBaseUrl: baseURL,
				npm: providerNpm,
				apiFormat,
				isProviderFallback: true,
			};
			map[`${providerId}/*`] = fallbackRoute;
			continue;
		}

		for (const modelId of modelIds) {
			const modelConfig = provider.models?.[modelId];
			// Model-level npm overrides provider-level npm for format detection.
			const modelNpm = typeof modelConfig?.npm === "string" ? modelConfig.npm : providerNpm;
			const route: ModelRoute = {
				providerId,
				modelId,
				upstreamBaseUrl: baseURL,
				npm: modelNpm,
				apiFormat: inferApiFormat(modelNpm),
			};
			map[modelId] = route;
			map[`${providerId}/${modelId}`] = route;
		}

		// Wildcard fallback for models not explicitly listed in config.
		const providerFallback: ModelRoute = {
			providerId,
			modelId: "*",
			upstreamBaseUrl: baseURL,
			npm: providerNpm,
			apiFormat: inferApiFormat(providerNpm),
			isProviderFallback: true,
		};
		map[`${providerId}/*`] = providerFallback;
	}

	return map;
}

/**
 * List provider-level upstream routes for display and proxy bootstrap.
 *
 * @param config - Parsed OpenCode configuration.
 * @returns Array of provider routes with resolvable base URLs.
 */
function listRoutesFromConfig(config: OpenCodeConfig): ProviderRoute[] {
	const routes: ProviderRoute[] = [];

	for (const [id, provider] of Object.entries(config.provider || {})) {
		const baseURL = resolveProviderBaseUrl(id, provider);
		if (baseURL) {
			routes.push({ id, upstreamBaseUrl: baseURL });
		}
	}

	return routes;
}

/**
 * Ensure localhost bypasses system HTTP proxy so OpenCode talks to our local reverse proxy.
 *
 * Corporate proxies often intercept `HTTP_PROXY`; without `NO_PROXY` for
 * `127.0.0.1`, OpenCode would route through the corporate proxy instead of
 * hitting our local listener.
 *
 * @param existing - Current `NO_PROXY` env value, if any.
 * @returns Merged comma-separated NO_PROXY list including 127.0.0.1 and localhost.
 */
function appendNoProxy(existing: string | undefined): string {
	const required = ["127.0.0.1", "localhost"];
	const current = (existing || "")
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean);
	const merged = [...new Set([...current, ...required])];
	return merged.join(",");
}

/**
 * OpenCode tool profile consumed by `trace-runner.ts`.
 *
 * Always uses reverse-proxy mode. Config injection is inline via
 * `OPENCODE_CONFIG_CONTENT` — no filesystem overlay to clean up.
 */
export const opencodeProfile: ToolProfile = {
	name: "opencode",
	displayName: "OpenCode",
	logDirectory: ".opencode-trace",

	/** @inheritdoc ToolProfile.findBinary */
	findBinary(customPath?: string): string {
		return findOpenCodePath(customPath);
	},

	/** @inheritdoc ToolProfile.getBinaryPath */
	getBinaryPath(customPath?: string): string {
		return getOpenCodeBinaryPath(customPath);
	},

	/** @inheritdoc ToolProfile.listProviderRoutes */
	listProviderRoutes(): ProviderRoute[] {
		return listRoutesFromConfig(readOpenCodeConfig());
	},

	/** @inheritdoc ToolProfile.listModelRoutes */
	listModelRoutes(): Record<string, ModelRoute> {
		return buildModelRouteMap(readOpenCodeConfig());
	},

	/**
	 * Summarize upstream URLs for CLI startup logging.
	 *
	 * Returns a single URL when one provider is configured, a comma-separated
	 * `id → url` list for multiple providers, or the Anthropic default when
	 * no providers are configured.
	 */
	readUpstreamBaseUrl(): string {
		const routes = listRoutesFromConfig(readOpenCodeConfig());
		if (routes.length === 0) {
			return process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com";
		}
		if (routes.length === 1) {
			return routes[0].upstreamBaseUrl;
		}
		return routes.map((route) => `${route.id} → ${route.upstreamBaseUrl}`).join(", ");
	},

	/**
	 * Inject runtime OpenCode config so all providers point at the local proxy.
	 *
	 * Serializes a minimal `{ provider: { id: { options: { baseURL } } } }`
	 * object into `OPENCODE_CONFIG_CONTENT`. Removes `OPENCODE_CONFIG` from
	 * the child env because a file path would take precedence over the inline
	 * content override.
	 *
	 * @param proxyUrl - Local proxy URL (e.g. `http://127.0.0.1:PORT`).
	 */
	prepareSpawnEnv(proxyUrl: string): { tmpDir: string | null; spawnEnv: NodeJS.ProcessEnv } {
		const config = readOpenCodeConfig();
		const routes = listRoutesFromConfig(config);
		const proxyBase = proxyUrl.replace(/\/$/, "");

		if (routes.length === 0) {
			log(
				"Warning: no provider.options.baseURL found in OpenCode config — proxy may not intercept traffic",
				"yellow",
			);
		}

		// All providers share one proxy URL; routing is done by model name at request time.
		const providerOverrides: Record<string, { options: { baseURL: string } }> = {};
		for (const route of routes) {
			providerOverrides[route.id] = {
				options: { baseURL: proxyBase },
			};
		}

		// OPENCODE_CONFIG on disk would override OPENCODE_CONFIG_CONTENT — drop it.
		const { OPENCODE_CONFIG: _removedConfig, ...restEnv } = process.env;

		const spawnEnv: NodeJS.ProcessEnv = {
			...restEnv,
			OPENCODE_CONFIG_CONTENT: JSON.stringify({ provider: providerOverrides }),
			NO_PROXY: appendNoProxy(process.env.NO_PROXY),
		};

		return { tmpDir: null, spawnEnv };
	},

	/** No filesystem overlay — `OPENCODE_CONFIG_CONTENT` is ephemeral. */
	cleanupTempConfig(_tmpDir: string | null): void {
		// OPENCODE_CONFIG_CONTENT is inline — nothing to clean up.
	},

	/** OpenCode has no Node.js fetch hook; proxy mode only. */
	supportsNodeInterceptor(): boolean {
		return false;
	},
};

/** Re-exported for tests and `trace-runner.ts` binary detection. */
export { getOpenCodeBinaryPath, isNativeBinary, buildModelRouteMap, inferApiFormat };
