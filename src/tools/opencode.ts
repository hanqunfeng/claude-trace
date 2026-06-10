import { execSync } from "child_process";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import type { ApiFormat, ModelRoute, ProviderRoute, ToolProfile } from "./types";
import { inferApiFormatFromNpm } from "../api-format";
import { isNativeBinary } from "./binary-utils";
import { log } from "../cli-common";

interface OpenCodeModelConfig {
	name?: string;
	npm?: string;
	[key: string]: unknown;
}

interface OpenCodeProviderConfig {
	npm?: string;
	models?: Record<string, OpenCodeModelConfig>;
	options?: {
		baseURL?: string;
		[key: string]: unknown;
	};
	[key: string]: unknown;
}

interface OpenCodeConfig {
	provider?: Record<string, OpenCodeProviderConfig>;
	[key: string]: unknown;
}

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

		const msysMatch = opencodePath.match(/^\/([a-zA-Z])\//);
		if (msysMatch) {
			opencodePath = msysMatch[1].toUpperCase() + ":/" + opencodePath.slice(3);
		}

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

function getOpenCodeBinaryPath(customPath?: string): string {
	const opencodePath = findOpenCodePath(customPath);

	try {
		return fs.realpathSync(opencodePath);
	} catch {
		return opencodePath;
	}
}

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

function inferApiFormat(npm: string): ApiFormat {
	return inferApiFormatFromNpm(npm);
}

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

function appendNoProxy(existing: string | undefined): string {
	const required = ["127.0.0.1", "localhost"];
	const current = (existing || "")
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean);
	const merged = [...new Set([...current, ...required])];
	return merged.join(",");
}

export const opencodeProfile: ToolProfile = {
	name: "opencode",
	displayName: "OpenCode",
	logDirectory: ".opencode-trace",

	findBinary(customPath?: string): string {
		return findOpenCodePath(customPath);
	},

	getBinaryPath(customPath?: string): string {
		return getOpenCodeBinaryPath(customPath);
	},

	listProviderRoutes(): ProviderRoute[] {
		return listRoutesFromConfig(readOpenCodeConfig());
	},

	listModelRoutes(): Record<string, ModelRoute> {
		return buildModelRouteMap(readOpenCodeConfig());
	},

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

		const { OPENCODE_CONFIG: _removedConfig, ...restEnv } = process.env;

		const spawnEnv: NodeJS.ProcessEnv = {
			...restEnv,
			OPENCODE_CONFIG_CONTENT: JSON.stringify({ provider: providerOverrides }),
			NO_PROXY: appendNoProxy(process.env.NO_PROXY),
		};

		return { tmpDir: null, spawnEnv };
	},

	cleanupTempConfig(_tmpDir: string | null): void {
		// OPENCODE_CONFIG_CONTENT is inline — nothing to clean up.
	},

	supportsNodeInterceptor(): boolean {
		return false;
	},
};

export { getOpenCodeBinaryPath, isNativeBinary, buildModelRouteMap, inferApiFormat };
