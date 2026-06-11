/**
 * @file trace-runner.ts
 * @description Generic launch orchestrator for all Tool Profiles.
 *
 * Chooses interception strategy based on binary type:
 * - **Native binary** (Claude V2+, OpenCode, Codex): local reverse proxy + env/config overlay
 * - **Node.js script** (Claude V1): spawn with `--require interceptor-loader.js`
 *
 * Handles proxy lifecycle, signal forwarding, and temp config cleanup on exit.
 */

import { spawn, ChildProcess } from "child_process";
import * as path from "path";
import * as fs from "fs";
import { ReverseProxyServer } from "./reverse-proxy";
import type { ToolProfile, TraceOptions } from "./tools/types";
import { isNativeBinary, resolveToJsFile } from "./tools/binary-utils";
import { isPersistentOverlayDir } from "./claude-config-overlay";
import { isPersistentCodexOverlayDir } from "./codex-config-overlay";
import type { ProviderRoute } from "./tools/types";
import { log } from "./cli-common";

/** Resolve path to interceptor-loader.js copied into dist/ at build time. */
function getLoaderPath(): string {
	const loaderPath = path.join(__dirname, "interceptor-loader.js");

	if (!fs.existsSync(loaderPath)) {
		log(`Interceptor loader not found at: ${loaderPath}`, "red");
		process.exit(1);
	}

	return loaderPath;
}

/**
 * Launch a native CLI with ReverseProxyServer and tool-specific config overlay.
 * Sets ANTHROPIC_BASE_URL / OPENCODE_CONFIG_CONTENT / CODEX_HOME as appropriate.
 */
async function runNativeWithProxy(
	profile: ToolProfile,
	binaryPath: string,
	toolArgs: string[],
	options: TraceOptions,
): Promise<void> {
	log("Using reverse proxy mode for native binary", "yellow");

	const providerRoutes = profile.listProviderRoutes?.() ?? [];
	const modelRoutes = profile.listModelRoutes?.() ?? {};
	const hasModelRoutes = Object.keys(modelRoutes).length > 0;
	const upstreamBaseUrl =
		providerRoutes.length > 0 ? providerRoutes[0].upstreamBaseUrl : profile.readUpstreamBaseUrl();
	// Simple id→URL map when no per-model routing (legacy single-upstream mode)
	const routes =
		!hasModelRoutes && providerRoutes.length > 0
			? Object.fromEntries(providerRoutes.map((route) => [route.id, route.upstreamBaseUrl]))
			: undefined;

	if (hasModelRoutes) {
		const uniqueModels = new Set<string>();
		for (const route of Object.values(modelRoutes)) {
			uniqueModels.add(`${route.providerId}/${route.modelId} (${route.apiFormat}) → ${route.upstreamBaseUrl}`);
		}
		log(`Model-based routing (${uniqueModels.size} model(s)):`, "blue");
		for (const entry of uniqueModels) {
			log(`  ${entry}`, "blue");
		}
	} else if (providerRoutes.length > 0) {
		log(`Intercepting ${providerRoutes.length} provider(s):`, "blue");
		for (const route of providerRoutes) {
			log(`  ${route.id} → ${route.upstreamBaseUrl}`, "blue");
		}
	} else {
		log(`Upstream API: ${upstreamBaseUrl}`, "blue");
	}
	console.log("");

	// Codex needs path-prefix-aware provider routes for OpenAI vs ChatGPT OAuth upstreams
	const codexProviderRoutes: ProviderRoute[] | undefined =
		profile.name === "codex" && providerRoutes.length > 0 ? providerRoutes : undefined;

	const proxy = new ReverseProxyServer({
		logDirectory: profile.logDirectory,
		logBaseName: options.logBaseName,
		includeAllRequests: options.includeAllRequests,
		openBrowser: options.openInBrowser,
		logSensitiveHeaders: options.logSensitiveHeaders,
		targetBaseUrl: upstreamBaseUrl,
		routes,
		modelRoutes: hasModelRoutes ? modelRoutes : undefined,
		providerRoutes: codexProviderRoutes,
		tool: profile.name,
	});

	let proxyInfo: { port: number; url: string };
	let tmpConfigDir: string | null = null;
	let shutdownCalled = false;

	/** Idempotent teardown: stop proxy and remove ephemeral overlay dirs. */
	const shutdown = (): void => {
		if (shutdownCalled) {
			return;
		}
		shutdownCalled = true;
		proxy.stop();
		profile.cleanupTempConfig(tmpConfigDir);
	};

	try {
		proxyInfo = await proxy.start();
		log(`Reverse proxy started at ${proxyInfo.url}`, "green");
		console.log("");
	} catch (error) {
		const err = error as Error;
		log(`Failed to start reverse proxy: ${err.message}`, "red");
		process.exit(1);
	}

	const { tmpDir, spawnEnv } = profile.prepareSpawnEnv(proxyInfo.url);
	tmpConfigDir = tmpDir;

	if (
		tmpConfigDir &&
		(isPersistentOverlayDir(tmpConfigDir) || isPersistentCodexOverlayDir(tmpConfigDir))
	) {
		log(`Using ${profile.displayName} config overlay (original settings unchanged)`, "blue");
	} else if (tmpConfigDir) {
		log(`Using temporary ${profile.displayName} config (original config unchanged)`, "blue");
	} else if (spawnEnv.OPENCODE_CONFIG_CONTENT) {
		log(`Using OPENCODE_CONFIG_CONTENT runtime override (original config unchanged)`, "blue");
	}

	const child: ChildProcess = spawn(binaryPath, toolArgs, {
		env: spawnEnv,
		stdio: "inherit",
		cwd: process.cwd(),
	});

	child.on("error", (error: Error) => {
		shutdown();
		log(`Error starting ${profile.displayName}: ${error.message}`, "red");
		process.exit(1);
	});

	child.on("exit", (code: number | null, signal: string | null) => {
		shutdown();

		if (signal) {
			log(`\n${profile.displayName} terminated by signal: ${signal}`, "yellow");
		} else if (code !== 0 && code !== null) {
			log(`\n${profile.displayName} exited with code: ${code}`, "yellow");
		} else {
			log(`\n${profile.displayName} session completed`, "green");
		}
	});

	const handleSignal = (signal: NodeJS.Signals) => {
		log(`\nReceived ${signal}, shutting down...`, "yellow");
		shutdown();
		if (child.pid) {
			child.kill(signal);
		}
	};

	process.on("SIGINT", () => handleSignal("SIGINT"));
	process.on("SIGTERM", () => handleSignal("SIGTERM"));

	try {
		await new Promise<void>((resolve, reject) => {
			child.on("exit", () => resolve());
			child.on("error", reject);
		});
	} catch (error) {
		const err = error as Error;
		shutdown();
		log(`Unexpected error: ${err.message}`, "red");
		process.exit(1);
	}

	shutdown();
}

/**
 * Launch Claude Code V1 (Node.js) with fetch() interception via preloaded module.
 * Environment variables configure logging behavior inside interceptor-loader.js.
 */
async function runNodeInterceptor(
	profile: ToolProfile,
	binaryPath: string,
	toolArgs: string[],
	options: TraceOptions,
): Promise<void> {
	const jsPath = resolveToJsFile(binaryPath);
	const loaderPath = getLoaderPath();

	log(`Using JavaScript entry: ${jsPath}`, "blue");
	log("Starting traffic logger...", "green");
	console.log("");

	const spawnArgs = ["--require", loaderPath, jsPath, ...toolArgs];
	const child: ChildProcess = spawn("node", spawnArgs, {
		env: {
			...process.env,
			NODE_OPTIONS: "--no-deprecation",
			CLAUDE_TRACE_INCLUDE_ALL_REQUESTS: options.includeAllRequests ? "true" : "false",
			CLAUDE_TRACE_OPEN_BROWSER: options.openInBrowser ? "true" : "false",
			...(options.logBaseName ? { CLAUDE_TRACE_LOG_NAME: options.logBaseName } : {}),
		},
		stdio: "inherit",
		cwd: process.cwd(),
	});

	child.on("error", (error: Error) => {
		log(`Error starting ${profile.displayName}: ${error.message}`, "red");
		process.exit(1);
	});

	child.on("exit", (code: number | null, signal: string | null) => {
		if (signal) {
			log(`\n${profile.displayName} terminated by signal: ${signal}`, "yellow");
		} else if (code !== 0 && code !== null) {
			log(`\n${profile.displayName} exited with code: ${code}`, "yellow");
		} else {
			log(`\n${profile.displayName} session completed`, "green");
		}
	});

	const handleSignal = (signal: NodeJS.Signals) => {
		log(`\nReceived ${signal}, shutting down...`, "yellow");
		if (child.pid) {
			child.kill(signal);
		}
	};

	process.on("SIGINT", () => handleSignal("SIGINT"));
	process.on("SIGTERM", () => handleSignal("SIGTERM"));

	try {
		await new Promise<void>((resolve, reject) => {
			child.on("exit", () => resolve());
			child.on("error", reject);
		});
	} catch (error) {
		const err = error as Error;
		log(`Unexpected error: ${err.message}`, "red");
		process.exit(1);
	}
}

/**
 * Main entry used by all three CLI binaries after argument parsing.
 * Detects binary type and delegates to proxy or interceptor mode.
 *
 * @param profile - Tool-specific ToolProfile implementation
 * @param toolArgs - Arguments forwarded to the underlying CLI (after --run-with)
 * @param options - Logging and spawn options from CLI flags
 */
export async function runWithTracing(
	profile: ToolProfile,
	toolArgs: string[] = [],
	options: TraceOptions = {},
): Promise<void> {
	log(`${profile.displayName} Trace`, "blue");
	log(`Starting ${profile.displayName} with traffic logging`, "yellow");
	if (toolArgs.length > 0) {
		log(`${profile.displayName} arguments: ${toolArgs.join(" ")}`, "blue");
	}
	console.log("");

	const binaryPath = profile.getBinaryPath(options.customBinaryPath);
	log(`Using ${profile.displayName} binary: ${binaryPath}`, "blue");

	if (isNativeBinary(binaryPath) || !profile.supportsNodeInterceptor()) {
		if (isNativeBinary(binaryPath)) {
			log("Detected native binary", "yellow");
		}
		await runNativeWithProxy(profile, binaryPath, toolArgs, options);
		return;
	}

	await runNodeInterceptor(profile, binaryPath, toolArgs, options);
}
