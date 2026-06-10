import { execSync } from "child_process";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import type { ModelRoute, ProviderRoute, ToolProfile } from "./types";
import {
	getCodexConfigOverlayDir,
	hasChatGptAuth,
	isPersistentCodexOverlayDir,
	readCodexConfig,
	resolveUserCodexHome,
	syncCodexConfigOverlay,
	RESERVED_BUILTIN_PROVIDERS,
	type CodexConfig,
	type CodexModelProvider,
} from "../codex-config-overlay";
import { isNativeBinary } from "./binary-utils";
import { log } from "../cli-common";

const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_CHATGPT_BASE_URL = "https://chatgpt.com/backend-api/codex";
const RESPONSES_NPM = "@openai/codex-responses";

const OPENAI_PATH_PREFIXES = ["/v1/responses", "/responses"];
const CHATGPT_PATH_PREFIXES = ["/backend-api/codex"];

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

function getCodexBinaryPath(customPath?: string): string {
	const codexPath = findCodexPath(customPath);

	try {
		return fs.realpathSync(codexPath);
	} catch {
		return codexPath;
	}
}

function resolveOpenAiBaseUrl(config: CodexConfig): string {
	return config.openai_base_url || process.env.OPENAI_BASE_URL || DEFAULT_OPENAI_BASE_URL;
}

function resolveChatGptBaseUrl(config: CodexConfig): string {
	return config.chatgpt_base_url || DEFAULT_CHATGPT_BASE_URL;
}

function shouldIncludeOpenAiRoute(config: CodexConfig, codexHome: string): boolean {
	if (config.openai_base_url || process.env.OPENAI_API_KEY || process.env.OPENAI_BASE_URL) {
		return true;
	}

	const modelProvider = config.model_provider;
	if (!modelProvider || modelProvider === "openai") {
		return true;
	}

	if (RESERVED_BUILTIN_PROVIDERS.has(modelProvider) && modelProvider !== "openai") {
		return false;
	}

	const custom = config.model_providers?.[modelProvider];
	return !custom?.base_url;
}

function shouldIncludeChatGptRoute(config: CodexConfig, codexHome: string): boolean {
	if (config.chatgpt_base_url) {
		return true;
	}
	return hasChatGptAuth(codexHome);
}

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

export function listRoutesFromCodexConfig(config: CodexConfig, codexHome?: string): ProviderRoute[] {
	const home = codexHome || resolveUserCodexHome();
	const routes: ProviderRoute[] = [];
	const modelProvider = config.model_provider;

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
			matchPathPrefixes: CHATGPT_PATH_PREFIXES,
		});
	}

	for (const route of listCustomProviderRoutes(config)) {
		if (!routes.some((existing) => existing.id === route.id)) {
			routes.push(route);
		}
	}

	return routes;
}

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

export function buildCodexModelRouteMap(config: CodexConfig, codexHome?: string): Record<string, ModelRoute> {
	const map: Record<string, ModelRoute> = {};
	const routes = listRoutesFromCodexConfig(config, codexHome);
	const model = config.model;

	if (!model) {
		return map;
	}

	const modelProvider = config.model_provider || "openai";
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

function appendNoProxy(existing: string | undefined): string {
	const required = ["127.0.0.1", "localhost"];
	const current = (existing || "")
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean);
	const merged = [...new Set([...current, ...required])];
	return merged.join(",");
}

export const codexProfile: ToolProfile = {
	name: "codex",
	displayName: "Codex CLI",
	logDirectory: ".codex-trace",

	findBinary(customPath?: string): string {
		return findCodexPath(customPath);
	},

	getBinaryPath(customPath?: string): string {
		return getCodexBinaryPath(customPath);
	},

	listProviderRoutes(): ProviderRoute[] {
		const home = resolveUserCodexHome();
		return listRoutesFromCodexConfig(readCodexConfig(home), home);
	},

	listModelRoutes(): Record<string, ModelRoute> {
		const home = resolveUserCodexHome();
		return buildCodexModelRouteMap(readCodexConfig(home), home);
	},

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

	supportsNodeInterceptor(): boolean {
		return false;
	},
};

export { getCodexBinaryPath, isNativeBinary };
