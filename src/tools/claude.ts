/**
 * @file tools/claude.ts
 * @description Tool profile for Claude Code CLI tracing.
 *
 * This module is the Claude-specific implementation of the {@link ToolProfile}
 * interface consumed by `trace-runner.ts`. Responsibilities include:
 *
 * - **Binary resolution** — locate Claude on PATH, unwrap bash/npm wrappers,
 *   and distinguish V1 Node.js scripts from V2+ native Mach-O/ELF/PE binaries.
 * - **Upstream URL discovery** — read `ANTHROPIC_BASE_URL` from `settings.json`
 *   or environment so the reverse proxy knows where to forward traffic.
 * - **Spawn environment** — set `ANTHROPIC_BASE_URL` to the local proxy; when
 *   `settings.json` also defines that variable, build a persistent config overlay
 *   at `~/.claude-trace/claude-config-overlay/` so the proxy URL wins without
 *   editing the user's original `~/.claude` directory.
 * - **OAuth token extraction** — optional `--extract-token` mode that preloads
 *   `token-extractor.js` to capture a bearer token for SDK usage.
 *
 * Interception mode is chosen by `trace-runner.ts` after calling
 * `isNativeBinary(getBinaryPath())`: native → reverse proxy, Node script →
 * `node --require interceptor-loader.js`.
 */

import { execSync, spawn, ChildProcess } from "child_process";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import type { ToolProfile } from "./types";
import {
	getClaudeConfigOverlayDir,
	isPersistentOverlayDir,
	resolveUserClaudeConfigDir,
	syncClaudeConfigOverlay,
	writeOverlaySettings,
} from "../claude-config-overlay";
import { isNativeBinary, resolveToJsFile } from "./binary-utils";
import { log, traceDebug } from "../cli-common";

/**
 * Locate the Claude CLI executable on PATH or in common install locations.
 *
 * Handles MSYS/Git Bash drive-letter paths (`/c/...` → `C:/...`) and shell
 * alias expansion (`claude: aliased to /path/to/claude`).
 *
 * @param customPath - Optional explicit path from `--claude-path`.
 * @returns Resolved path to the Claude launcher script or binary.
 * @throws Exits the process with code 1 if no binary is found.
 */
function findClaudePath(customPath?: string): string {
	if (customPath) {
		if (!fs.existsSync(customPath)) {
			log(`Claude binary not found at specified path: ${customPath}`, "red");
			process.exit(1);
		}
		return customPath;
	}

	const isWindows = process.platform === "win32";

	try {
		const findCmd = isWindows ? "where.exe claude" : "which claude";
		let claudePath = execSync(findCmd, { encoding: "utf-8" }).trim().split(/\r?\n/)[0];

		// Git Bash / MSYS returns POSIX-style Windows paths like /c/Users/...
		const msysMatch = claudePath.match(/^\/([a-zA-Z])\//);
		if (msysMatch) {
			claudePath = msysMatch[1].toUpperCase() + ":/" + claudePath.slice(3);
		}

		// zsh/fish may report "claude: aliased to /actual/path"
		const aliasMatch = claudePath.match(/:\s*aliased to\s+(.+)$/);
		if (aliasMatch && aliasMatch[1]) {
			claudePath = aliasMatch[1];
		}

		return claudePath;
	} catch {
		// `which`/`where.exe` failed — scan well-known install paths.
		const possiblePaths = isWindows
			? [
					path.join(os.homedir(), ".local", "bin", "claude.exe"),
					path.join(process.env.APPDATA || "", "npm", "claude.cmd"),
					path.join(process.env.APPDATA || "", "npm", "claude"),
				]
			: [
					path.join(os.homedir(), ".claude", "bin", "claude"),
					path.join(os.homedir(), ".claude", "local", "claude"),
					path.join(os.homedir(), ".local", "bin", "claude"),
					"/opt/homebrew/bin/claude",
					"/usr/local/bin/claude",
					"/usr/bin/claude",
				];

		for (const p of possiblePaths) {
			if (fs.existsSync(p)) {
				return p;
			}
		}

		log(`Claude CLI not found in PATH or common locations`, "red");
		log(`Please install Claude Code CLI first`, "red");
		process.exit(1);
	}
}

/**
 * Resolve the JavaScript entry point for V1 Node.js interceptor mode.
 *
 * Follows bash wrapper scripts that `exec` into the real `.js` launcher so
 * `node --require interceptor` can hook `fetch`. Only used when the resolved
 * binary is not a native executable.
 *
 * @param customPath - Optional explicit path from `--claude-path`.
 * @returns Absolute path to the Claude JS entry file.
 */
function getClaudeAbsolutePath(customPath?: string): string {
	const claudePath = findClaudePath(customPath);
	const isWindows = process.platform === "win32";

	if (!isWindows && fs.existsSync(claudePath)) {
		const content = fs.readFileSync(claudePath, "utf-8");
		if (content.startsWith("#!/bin/bash") || content.startsWith("#!/bin/sh")) {
			const execMatch = content.match(/exec\s+"([^"]+)"/);
			if (execMatch && execMatch[1]) {
				return resolveToJsFile(execMatch[1]);
			}
		}
	}

	return resolveToJsFile(claudePath);
}

/**
 * Resolve the real executable used for native-binary detection and proxy mode.
 *
 * Unwraps npm `.cmd` shims, bash wrappers, and symlinks to find the actual
 * Mach-O/ELF/PE binary (V2+) or `.exe` on Windows. This path is passed to
 * `isNativeBinary()` in `trace-runner.ts` to choose proxy vs interceptor.
 *
 * @param customPath - Optional explicit path from `--claude-path`.
 * @returns Absolute path to the underlying Claude executable.
 */
function getClaudeBinaryPath(customPath?: string): string {
	const claudePath = findClaudePath(customPath);
	const isWindows = process.platform === "win32";

	if (isWindows && fs.existsSync(claudePath)) {
		const content = fs.readFileSync(claudePath, "utf-8");

		// npm .cmd shim: "%dp0%\node_modules\@anthropic-ai\claude-code\bin\claude.exe"
		const cmdMatch = content.match(/"?%dp0%\\([^"]+\.exe)"?\s/i);
		if (cmdMatch && cmdMatch[1]) {
			const dir = path.dirname(claudePath);
			const resolved = path.join(dir, cmdMatch[1]);
			if (fs.existsSync(resolved)) {
				return resolved;
			}
		}

		// Git Bash npm shim: exec "$basedir/node_modules/.../claude.exe"
		const shMatch = content.match(/exec\s+"?\$basedir\/([^"]+\.exe)"?\s/);
		if (shMatch && shMatch[1]) {
			const dir = path.dirname(claudePath);
			const resolved = path.join(dir, shMatch[1]);
			if (fs.existsSync(resolved)) {
				return resolved;
			}
		}

		if (claudePath.endsWith(".exe")) {
			try {
				return fs.realpathSync(claudePath);
			} catch {
				return claudePath;
			}
		}

		const exePath = claudePath + ".exe";
		if (fs.existsSync(exePath)) {
			return exePath;
		}

		// Fallback: npm global install layout
		const dir = path.dirname(claudePath);
		const npmExePath = path.join(dir, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
		if (fs.existsSync(npmExePath)) {
			return npmExePath;
		}
	}

	if (!isWindows && fs.existsSync(claudePath)) {
		const content = fs.readFileSync(claudePath, "utf-8");
		if (content.startsWith("#!/bin/bash") || content.startsWith("#!/bin/sh")) {
			const execMatch = content.match(/exec\s+"([^"]+)"/);
			if (execMatch && execMatch[1]) {
				try {
					return fs.realpathSync(execMatch[1]);
				} catch {
					return execMatch[1];
				}
			}
		}
	}

	try {
		return fs.realpathSync(claudePath);
	} catch {
		return claudePath;
	}
}

/**
 * Resolve the user's Claude config directory (`CLAUDE_CONFIG_DIR` or `~/.claude`).
 *
 * @returns Absolute path to the Claude configuration directory.
 */
function getClaudeConfigDir(): string {
	return resolveUserClaudeConfigDir();
}

/**
 * Claude Code tool profile consumed by `trace-runner.ts`.
 *
 * Supports both V1 Node interceptor and V2+ reverse-proxy interception.
 * When `settings.json` defines its own `ANTHROPIC_BASE_URL`, a persistent
 * config overlay rewrites that value without modifying the original file.
 */
export const claudeProfile: ToolProfile = {
	name: "claude",
	displayName: "Claude Code",
	logDirectory: ".claude-trace",

	/** @inheritdoc ToolProfile.findBinary */
	findBinary(customPath?: string): string {
		return findClaudePath(customPath);
	},

	/** @inheritdoc ToolProfile.getBinaryPath */
	getBinaryPath(customPath?: string): string {
		return getClaudeBinaryPath(customPath);
	},

	/**
	 * Read the upstream Anthropic API base URL for proxy forwarding.
	 *
	 * Precedence: `settings.json` → `ANTHROPIC_BASE_URL` env → default
	 * `https://api.anthropic.com`.
	 */
	readUpstreamBaseUrl(): string {
		const settingsPath = path.join(getClaudeConfigDir(), "settings.json");

		if (fs.existsSync(settingsPath)) {
			try {
				const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8")) as {
					env?: { ANTHROPIC_BASE_URL?: string };
				};
				if (settings.env?.ANTHROPIC_BASE_URL) {
					return settings.env.ANTHROPIC_BASE_URL;
				}
			} catch {
				// Fall through to environment/default
			}
		}

		return process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com";
	},

	/**
	 * Build spawn environment pointing Claude at the local reverse proxy.
	 *
	 * Always sets `ANTHROPIC_BASE_URL` to `proxyUrl`. When the user's
	 * `settings.json` also sets that variable (which would override the env
	 * var inside Claude), creates a config overlay and sets `CLAUDE_CONFIG_DIR`
	 * to the overlay path.
	 *
	 * @param proxyUrl - Local proxy URL (e.g. `http://127.0.0.1:PORT`).
	 */
	prepareSpawnEnv(proxyUrl: string): { tmpDir: string | null; spawnEnv: NodeJS.ProcessEnv } {
		const sourceConfigDir = resolveUserClaudeConfigDir();
		const settingsPath = path.join(sourceConfigDir, "settings.json");
		let tmpDir: string | null = null;

		const spawnEnv: NodeJS.ProcessEnv = {
			...process.env,
			ANTHROPIC_BASE_URL: proxyUrl,
		};

		if (fs.existsSync(settingsPath)) {
			try {
				const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8")) as {
					env?: Record<string, string>;
				};

				// settings.json env overrides ANTHROPIC_BASE_URL — build overlay so
				// the proxy URL wins without editing the user's original config.
				if (settings.env?.ANTHROPIC_BASE_URL) {
					const overlayDir = getClaudeConfigOverlayDir();
					const syncResult = syncClaudeConfigOverlay(sourceConfigDir, overlayDir, os.homedir());
					writeOverlaySettings(settingsPath, overlayDir);
					tmpDir = overlayDir;
					spawnEnv.CLAUDE_CONFIG_DIR = overlayDir;

					if (syncResult.skipped.length > 0) {
						traceDebug(
							`claude-trace: overlay linked ${syncResult.linked.length}, skipped ${syncResult.skipped.length} (proxy still active)`,
						);
						for (const skip of syncResult.skipped) {
							traceDebug(`claude-trace: overlay skip ${skip.entry}: ${skip.reason}`);
						}
					}
				}
			} catch (error) {
				const err = error as Error;
				log(`Warning: could not prepare Claude config overlay: ${err.message}`, "yellow");
			}
		}

		return { tmpDir, spawnEnv };
	},

	/**
	 * Remove a temporary overlay directory after the session ends.
	 *
	 * Skips the persistent overlay at `~/.claude-trace/claude-config-overlay/`
	 * which is intentionally reused across runs.
	 */
	cleanupTempConfig(tmpDir: string | null): void {
		// Persistent overlay at ~/.claude-trace/claude-config-overlay/ is reused across runs.
		if (!tmpDir || isPersistentOverlayDir(tmpDir)) {
			return;
		}

		try {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		} catch {
			// Best-effort cleanup
		}
	},

	/** Claude V1 Node.js installs support the `--require interceptor` hook. */
	supportsNodeInterceptor(): boolean {
		return true;
	},
};

/**
 * Extract the OAuth bearer token from a live Claude Code session.
 *
 * Spawns Claude via `node --require token-extractor.js` with a minimal prompt,
 * watches for the token written to `.claude-trace/token.txt`, and prints it
 * to stdout (for `export ANTHROPIC_API_KEY=$(claude-trace --extract-token)`).
 *
 * Uses polling (500 ms) and a 30 s timeout so the child can be killed as soon
 * as the token is captured, without waiting for a full Claude session to finish.
 *
 * @param customClaudePath - Optional explicit path from `--claude-path`.
 */
export async function extractClaudeToken(customClaudePath?: string): Promise<void> {
	const claudePath = getClaudeAbsolutePath(customClaudePath);

	console.error(`Using Claude binary: ${claudePath}`);

	const claudeTraceDir = path.join(process.cwd(), claudeProfile.logDirectory);
	if (!fs.existsSync(claudeTraceDir)) {
		fs.mkdirSync(claudeTraceDir, { recursive: true });
	}

	const tokenFile = path.join(claudeTraceDir, "token.txt");
	const tokenExtractorPath = path.join(__dirname, "..", "token-extractor.js");

	if (!fs.existsSync(tokenExtractorPath)) {
		log(`Token extractor not found at: ${tokenExtractorPath}`, "red");
		process.exit(1);
	}

	const cleanup = (): void => {
		try {
			if (fs.existsSync(tokenFile)) fs.unlinkSync(tokenFile);
		} catch {
			// Ignore cleanup errors
		}
	};

	// Strip ANTHROPIC_API_KEY so Claude uses OAuth flow instead of API key auth.
	const { ANTHROPIC_API_KEY: _removed, ...envWithoutApiKey } = process.env;
	const child: ChildProcess = spawn("node", ["--require", tokenExtractorPath, claudePath, "-p", "hello"], {
		env: {
			...envWithoutApiKey,
			NODE_TLS_REJECT_UNAUTHORIZED: "0",
			CLAUDE_TRACE_TOKEN_FILE: tokenFile,
		},
		stdio: "inherit",
		cwd: process.cwd(),
	});

	const timeout = setTimeout(() => {
		child.kill();
		cleanup();
		console.error("Timeout: No token found within 30 seconds");
		process.exit(1);
	}, 30000);

	child.on("error", (error: Error) => {
		clearTimeout(timeout);
		cleanup();
		console.error(`Error starting Claude: ${error.message}`);
		process.exit(1);
	});

	child.on("exit", () => {
		clearTimeout(timeout);

		try {
			if (fs.existsSync(tokenFile)) {
				const token = fs.readFileSync(tokenFile, "utf-8").trim();
				cleanup();
				if (token) {
					console.log(token);
					process.exit(0);
				}
			}
		} catch {
			// File doesn't exist or read error
		}

		cleanup();
		console.error("No authorization token found");
		process.exit(1);
	});

	// Poll for early token capture so we can kill Claude before full session startup.
	const checkToken = setInterval(() => {
		try {
			if (fs.existsSync(tokenFile)) {
				const token = fs.readFileSync(tokenFile, "utf-8").trim();
				if (token) {
					clearTimeout(timeout);
					clearInterval(checkToken);
					child.kill();
					cleanup();
					console.log(token);
					process.exit(0);
				}
			}
		} catch {
			// Ignore read errors, keep trying
		}
	}, 500);
}

/** Re-exported for `trace-runner.ts` binary detection and V1 path resolution. */
export { getClaudeBinaryPath, isNativeBinary, resolveToJsFile };
