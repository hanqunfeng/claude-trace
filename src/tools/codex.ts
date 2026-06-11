/**
 * @file tools/codex.ts
 * @description Tool profile for OpenAI Codex CLI tracing.
 *
 * This module implements the {@link ToolProfile} interface for the Codex CLI.
 * Codex is a **Rust native binary** — it always uses reverse-proxy interception;
 * there is no Node.js interceptor path.
 *
 * Key responsibilities:
 *
 * - **Binary resolution** — locate `codex` on PATH (same MSYS/alias handling
 *   as other profiles).
 * - **TOML config reading** — load `config.toml` from `$CODEX_HOME` (default
 *   `~/.codex/`) via `codex-config-overlay.ts`.
 * - **Path-based upstream routing** — register separate upstreams for OpenAI
 *   API Key auth (`/v1/responses`), ChatGPT OAuth (`/backend-api/codex`), ChatGPT
 *   Apps MCP (`/backend-api/wham`), and custom `model_providers.*.base_url` entries.
 *   Dispatch is handled in `codex-routing.ts` using `matchPathPrefixes` on each
 *   {@link ProviderRoute}.
 * - **Config overlay** — build a persistent `$CODEX_HOME` overlay at
 *   `~/.claude-trace/codex-config-overlay/` that rewrites `openai_base_url`,
 *   `chatgpt_base_url`, and custom provider URLs to the local proxy.
 *
 * Codex uses the OpenAI Responses API wire format exclusively; all model routes
 * are tagged with `apiFormat: "openai-responses"`.
 */

import { execSync } from "child_process";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import type { ModelRoute, ProviderRoute, ToolProfile } from "./types";
import {
	getCodexConfigOverlayDir,
	hasChatGptAuth,
	isChatGptAuthMode,
	isPersistentCodexOverlayDir,
	readCodexConfig,
	resolveUserCodexHome,
	syncCodexConfigOverlay,
	RESERVED_BUILTIN_PROVIDERS,
	type CodexConfig,
	type CodexModelProvider,
} from "../config/codex-config-overlay";
import { isNativeBinary } from "./binary-utils";
import { log } from "../cli/cli-common";

/** Default upstream for OpenAI API Key auth (`/v1/responses`). */
const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
/** Default upstream for ChatGPT OAuth auth (`/backend-api/codex/responses`). */
const DEFAULT_CHATGPT_BASE_URL = "https://chatgpt.com/backend-api/codex";
/** npm hint for Codex Responses API wire format. */
const RESPONSES_NPM = "@openai/codex-responses";

/** Request path prefixes routed to the OpenAI API Key upstream. */
const OPENAI_PATH_PREFIXES = ["/v1/responses", "/responses"];
/** Request path prefixes routed to the ChatGPT OAuth upstream. */
const CHATGPT_PATH_PREFIXES = ["/backend-api/codex"];
/** Path prefix for ChatGPT Apps MCP (`codex_apps` → `/backend-api/wham/apps`). */
const CHATGPT_WHAM_PATH_PREFIXES = ["/backend-api/wham"];
/**
 * Proxy path Codex builds when `chatgpt_base_url` is a bare local proxy URL
 * (`http://127.0.0.1:PORT`) — see `codex_apps_mcp_url_for_base_url` in Codex source.
 */
const CHATGPT_APPS_MCP_PROXY_PATH_PREFIXES = ["/api/codex/apps"];
/** Canonical upstream path for ChatGPT Apps MCP on chatgpt.com. */
const CHATGPT_APPS_MCP_UPSTREAM_PATH = "/backend-api/wham/apps";

/**
 * Locate the Codex CLI executable on PATH or in common install locations.
 *
 * @param customPath - Optional explicit path from `--codex-path`.
 * @returns Resolved path to the Codex launcher.
 * @throws Exits the process with code 1 if no binary is found.
 */
function findCodexPath(customPath?: string): string {
	if (customPath) {
		if (!fs.existsSync(customPath)) {
			log(`Codex binary not found at specified path: ${customPath}`, "red");
			process.exit(1);
		}
		return customPath;
	}

	const isWindows = process.platform === "win32";

	try {
		const findCmd = isWindows ? "where.exe codex" : "which codex";
		let codexPath = execSync(findCmd, { encoding: "utf-8" }).trim().split(/\r?\n/)[0];

		const msysMatch = codexPath.match(/^\/([a-zA-Z])\//);
		if (msysMatch) {
			codexPath = msysMatch[1].toUpperCase() + ":/" + codexPath.slice(3);
		}

		const aliasMatch = codexPath.match(/:\s*aliased to\s+(.+)$/);
		if (aliasMatch && aliasMatch[1]) {
			codexPath = aliasMatch[1];
		}

		return codexPath;
	} catch {
		const possiblePaths = isWindows
			? [
					path.join(os.homedir(), ".local", "bin", "codex.exe"),
					path.join(process.env.APPDATA || "", "npm", "codex.cmd"),
					path.join(process.env.APPDATA || "", "npm", "codex"),
				]
			: [
					path.join(os.homedir(), ".local", "bin", "codex"),
					"/opt/homebrew/bin/codex",
					"/usr/local/bin/codex",
					"/usr/bin/codex",
				];

		for (const p of possiblePaths) {
			if (fs.existsSync(p)) {
				return p;
			}
		}

		log(`Codex CLI not found in PATH or common locations`, "red");
		log(`Please install Codex CLI first: https://github.com/openai/codex`, "red");
		process.exit(1);
	}
}

/**
 * Resolve symlinks to the real Codex executable path.
 *
 * @param customPath - Optional explicit path from `--codex-path`.
 * @returns Canonical binary path.
 */
function getCodexBinaryPath(customPath?: string): string {
	const codexPath = findCodexPath(customPath);

	try {
		return fs.realpathSync(codexPath);
	} catch {
		return codexPath;
	}
}

/**
 * Resolve the OpenAI API Key upstream base URL from config or environment.
 *
 * @param config - Parsed Codex TOML config.
 * @returns OpenAI-compatible base URL.
 */
function resolveOpenAiBaseUrl(config: CodexConfig): string {
	return config.openai_base_url || process.env.OPENAI_BASE_URL || DEFAULT_OPENAI_BASE_URL;
}

/**
 * Resolve the ChatGPT OAuth upstream base URL from config or default.
 *
 * @param config - Parsed Codex TOML config.
 * @returns ChatGPT backend base URL.
 */
function resolveChatGptBaseUrl(config: CodexConfig): string {
	return config.chatgpt_base_url || DEFAULT_CHATGPT_BASE_URL;
}

/**
 * ChatGPT site origin (scheme + host only) for `/backend-api/*` paths outside `/backend-api/codex`.
 *
 * Used for `codex_apps` MCP (`/backend-api/wham/apps`) so requests are not prefixed with
 * `/backend-api/codex` when forwarded upstream.
 *
 * @param config - Parsed Codex TOML config.
 */
function resolveChatGptSiteOrigin(config: CodexConfig): string {
	const parsed = new URL(resolveChatGptBaseUrl(config));
	return `${parsed.protocol}//${parsed.host}`;
}

/**
 * Path prefixes for the ChatGPT OAuth upstream.
 *
 * When `auth.json` sets `auth_mode: "chatgpt"`, Codex may POST to `/responses`
 * against the proxy base URL; those requests must still reach ChatGPT OAuth upstream.
 *
 * @param codexHome - User's `$CODEX_HOME` directory for auth file detection.
 */
function chatGptPathPrefixes(codexHome: string): string[] {
	if (isChatGptAuthMode(codexHome)) {
		return [...CHATGPT_PATH_PREFIXES, ...OPENAI_PATH_PREFIXES];
	}
	return CHATGPT_PATH_PREFIXES;
}

/**
 * Determine whether the OpenAI API Key route should be included.
 *
 * Included when explicit config/env signals OpenAI usage, or when the active
 * `model_provider` is unset/openai, or when a custom provider has no own base URL.
 * Excluded when another built-in provider (e.g. `chatgpt`) is active and owns routing,
 * or when `auth.json` explicitly selects ChatGPT OAuth (`auth_mode: "chatgpt"`).
 *
 * @param config - Parsed Codex TOML config.
 * @param codexHome - User's `$CODEX_HOME` directory for auth file detection.
 * @returns True if the OpenAI route should be registered.
 */
function shouldIncludeOpenAiRoute(config: CodexConfig, codexHome: string): boolean {
	if (isChatGptAuthMode(codexHome)) {
		return false;
	}

	if (config.openai_base_url || process.env.OPENAI_API_KEY || process.env.OPENAI_BASE_URL) {
		return true;
	}

	const modelProvider = config.model_provider;
	if (!modelProvider || modelProvider === "openai") {
		return true;
	}

	// Another built-in provider (e.g. chatgpt) owns routing — skip OpenAI unless custom.
	if (RESERVED_BUILTIN_PROVIDERS.has(modelProvider) && modelProvider !== "openai") {
		return false;
	}

	const custom = config.model_providers?.[modelProvider];
	return !custom?.base_url;
}

/**
 * Determine whether the ChatGPT OAuth route should be included.
 *
 * Active when `chatgpt_base_url` is set in config or when OAuth credentials
 * are present in `$CODEX_HOME` (detected by `hasChatGptAuth`).
 *
 * @param config - Parsed Codex TOML config.
 * @param codexHome - User's `$CODEX_HOME` directory for auth file detection.
 * @returns True if ChatGPT OAuth credentials or explicit URL are present.
 */
function shouldIncludeChatGptRoute(config: CodexConfig, codexHome: string): boolean {
	if (config.chatgpt_base_url) {
		return true;
	}
	return hasChatGptAuth(codexHome);
}

/**
 * Collect upstream routes for non-reserved custom `model_providers` entries.
 *
 * Skips built-in provider IDs (`openai`, `chatgpt`) which are handled
 * separately by `shouldIncludeOpenAiRoute` / `shouldIncludeChatGptRoute`.
 *
 * @param config - Parsed Codex TOML config.
 * @returns Provider routes for custom providers with explicit `base_url`.
 */
function listCustomProviderRoutes(config: CodexConfig): ProviderRoute[] {
	const routes: ProviderRoute[] = [];

	for (const [id, provider] of Object.entries(config.model_providers || {})) {
		if (RESERVED_BUILTIN_PROVIDERS.has(id)) {
			continue;
		}
		if (!provider.base_url) {
			continue;
		}
		routes.push({
			id,
			upstreamBaseUrl: provider.base_url,
			matchPathPrefixes: OPENAI_PATH_PREFIXES,
		});
	}

	return routes;
}

/**
 * Build the full list of upstream provider routes from Codex config.
 *
 * Combines the active custom provider, OpenAI API Key route, ChatGPT OAuth
 * route, and any additional custom providers. Each route carries
 * `matchPathPrefixes` for path-based dispatch in `codex-routing.ts`.
 *
 * @param config - Parsed Codex TOML config.
 * @param codexHome - Optional override for `$CODEX_HOME` (defaults to user home).
 * @returns Deduplicated provider route list.
 */
export function listRoutesFromCodexConfig(config: CodexConfig, codexHome?: string): ProviderRoute[] {
	const home = codexHome || resolveUserCodexHome();
	const routes: ProviderRoute[] = [];
	const modelProvider = config.model_provider;

	// Active custom provider takes priority when it has its own base_url.
	if (modelProvider && !RESERVED_BUILTIN_PROVIDERS.has(modelProvider)) {
		const custom = config.model_providers?.[modelProvider];
		if (custom?.base_url) {
			routes.push({
				id: modelProvider,
				upstreamBaseUrl: custom.base_url,
				matchPathPrefixes: OPENAI_PATH_PREFIXES,
			});
		}
	}

	if (shouldIncludeOpenAiRoute(config, home)) {
		routes.push({
			id: "openai",
			upstreamBaseUrl: resolveOpenAiBaseUrl(config),
			matchPathPrefixes: OPENAI_PATH_PREFIXES,
		});
	}

	if (shouldIncludeChatGptRoute(config, home)) {
		routes.push({
			id: "chatgpt",
			upstreamBaseUrl: resolveChatGptBaseUrl(config),
			matchPathPrefixes: chatGptPathPrefixes(home),
		});
		routes.push({
			id: "chatgpt-wham",
			upstreamBaseUrl: resolveChatGptSiteOrigin(config),
			matchPathPrefixes: CHATGPT_WHAM_PATH_PREFIXES,
		});
		routes.push({
			id: "chatgpt-apps-mcp",
			upstreamBaseUrl: resolveChatGptSiteOrigin(config),
			matchPathPrefixes: CHATGPT_APPS_MCP_PROXY_PATH_PREFIXES,
			fixedUpstreamPath: CHATGPT_APPS_MCP_UPSTREAM_PATH,
		});
	}

	for (const route of listCustomProviderRoutes(config)) {
		if (!routes.some((existing) => existing.id === route.id)) {
			routes.push(route);
		}
	}

	return routes;
}

/**
 * Construct a single {@link ModelRoute} for Codex Responses API traffic.
 *
 * All Codex routes use `apiFormat: "openai-responses"` regardless of auth mode.
 *
 * @param providerId - Active provider identifier.
 * @param modelId - Model name or `"*"` for wildcard fallback.
 * @param baseURL - Upstream base URL for this route.
 * @param isProviderFallback - True for `providerId/*` wildcard entries.
 */
function buildModelRoute(
	providerId: string,
	modelId: string,
	baseURL: string,
	isProviderFallback = false,
): ModelRoute {
	return {
		providerId,
		modelId,
		upstreamBaseUrl: baseURL,
		npm: RESPONSES_NPM,
		apiFormat: "openai-responses",
		isProviderFallback,
	};
}

/**
 * Build a model-keyed routing map for the Codex reverse proxy.
 *
 * Uses the configured `model` and `model_provider` to select the active
 * upstream, then registers both exact (`model`, `provider/model`) and wildcard
 * (`provider/*`) lookup keys.
 *
 * @param config - Parsed Codex TOML config.
 * @param codexHome - Optional override for `$CODEX_HOME`.
 * @returns Map from model lookup keys to {@link ModelRoute} entries.
 */
export function buildCodexModelRouteMap(config: CodexConfig, codexHome?: string): Record<string, ModelRoute> {
	const map: Record<string, ModelRoute> = {};
	const routes = listRoutesFromCodexConfig(config, codexHome);
	const model = config.model;

	if (!model) {
		return map;
	}

	const modelProvider = config.model_provider || "openai";
	// Prefer the configured provider, then OpenAI, then first available route.
	const activeRoute =
		routes.find((route) => route.id === modelProvider) ||
		routes.find((route) => route.id === "openai") ||
		routes[0];

	if (!activeRoute) {
		return map;
	}

	const route = buildModelRoute(modelProvider, model, activeRoute.upstreamBaseUrl);
	map[model] = route;
	map[`${modelProvider}/${model}`] = route;

	const fallback = buildModelRoute(modelProvider, "*", activeRoute.upstreamBaseUrl, true);
	map[`${modelProvider}/*`] = fallback;

	return map;
}

/**
 * Ensure localhost bypasses system HTTP proxy so Codex talks to our local reverse proxy.
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
 * Codex CLI tool profile consumed by `trace-runner.ts`.
 *
 * Always uses reverse-proxy mode with a persistent `$CODEX_HOME` overlay at
 * `~/.claude-trace/codex-config-overlay/`.
 */
export const codexProfile: ToolProfile = {
	name: "codex",
	displayName: "Codex CLI",
	logDirectory: ".codex-trace",

	/** @inheritdoc ToolProfile.findBinary */
	findBinary(customPath?: string): string {
		return findCodexPath(customPath);
	},

	/** @inheritdoc ToolProfile.getBinaryPath */
	getBinaryPath(customPath?: string): string {
		return getCodexBinaryPath(customPath);
	},

	/** @inheritdoc ToolProfile.listProviderRoutes */
	listProviderRoutes(): ProviderRoute[] {
		const home = resolveUserCodexHome();
		return listRoutesFromCodexConfig(readCodexConfig(home), home);
	},

	/** @inheritdoc ToolProfile.listModelRoutes */
	listModelRoutes(): Record<string, ModelRoute> {
		const home = resolveUserCodexHome();
		return buildCodexModelRouteMap(readCodexConfig(home), home);
	},

	/**
	 * Summarize upstream URLs for CLI startup logging.
	 *
	 * Returns a single URL, a comma-separated `id → url` list, or the OpenAI
	 * default when no routes are configured.
	 */
	readUpstreamBaseUrl(): string {
		const routes = codexProfile.listProviderRoutes?.() ?? [];
		if (routes.length === 0) {
			return DEFAULT_OPENAI_BASE_URL;
		}
		if (routes.length === 1) {
			return routes[0].upstreamBaseUrl;
		}
		return routes.map((route) => `${route.id} → ${route.upstreamBaseUrl}`).join(", ");
	},

	/**
	 * Build a `$CODEX_HOME` overlay with rewritten upstream URLs.
	 *
	 * Syncs the user's real `$CODEX_HOME` into the persistent overlay directory,
	 * rewrites base URLs to `proxyUrl`, and sets `CODEX_HOME` in the child env
	 * to point at the overlay.
	 *
	 * @param proxyUrl - Local proxy URL (e.g. `http://127.0.0.1:PORT`).
	 */
	prepareSpawnEnv(proxyUrl: string): { tmpDir: string | null; spawnEnv: NodeJS.ProcessEnv } {
		const sourceHome = resolveUserCodexHome();
		const overlayDir = getCodexConfigOverlayDir();
		const syncResult = syncCodexConfigOverlay(sourceHome, overlayDir, proxyUrl);

		if (syncResult.skipped.length > 0) {
			for (const skip of syncResult.skipped) {
				log(`Warning: codex overlay skip ${skip.entry}: ${skip.reason}`, "yellow");
			}
		}

		const spawnEnv: NodeJS.ProcessEnv = {
			...process.env,
			CODEX_HOME: overlayDir,
			NO_PROXY: appendNoProxy(process.env.NO_PROXY),
		};

		return { tmpDir: overlayDir, spawnEnv };
	},

	/**
	 * Remove a temporary overlay directory after the session ends.
	 *
	 * Skips the persistent overlay at `~/.claude-trace/codex-config-overlay/`.
	 */
	cleanupTempConfig(tmpDir: string | null): void {
		if (!tmpDir || isPersistentCodexOverlayDir(tmpDir)) {
			return;
		}

		try {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		} catch {
			// Best-effort cleanup
		}
	},

	/** Codex is a Rust binary — no Node.js fetch hook. */
	supportsNodeInterceptor(): boolean {
		return false;
	},
};

/** Re-exported for `trace-runner.ts` binary detection. */
export { getCodexBinaryPath, isNativeBinary };
