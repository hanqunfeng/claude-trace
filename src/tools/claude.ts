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

		const msysMatch = claudePath.match(/^\/([a-zA-Z])\//);
		if (msysMatch) {
			claudePath = msysMatch[1].toUpperCase() + ":/" + claudePath.slice(3);
		}

		const aliasMatch = claudePath.match(/:\s*aliased to\s+(.+)$/);
		if (aliasMatch && aliasMatch[1]) {
			claudePath = aliasMatch[1];
		}

		return claudePath;
	} catch {
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

function getClaudeBinaryPath(customPath?: string): string {
	const claudePath = findClaudePath(customPath);
	const isWindows = process.platform === "win32";

	if (isWindows && fs.existsSync(claudePath)) {
		const content = fs.readFileSync(claudePath, "utf-8");

		const cmdMatch = content.match(/"?%dp0%\\([^"]+\.exe)"?\s/i);
		if (cmdMatch && cmdMatch[1]) {
			const dir = path.dirname(claudePath);
			const resolved = path.join(dir, cmdMatch[1]);
			if (fs.existsSync(resolved)) {
				return resolved;
			}
		}

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

function getClaudeConfigDir(): string {
	return resolveUserClaudeConfigDir();
}

export const claudeProfile: ToolProfile = {
	name: "claude",
	displayName: "Claude Code",
	logDirectory: ".claude-trace",

	findBinary(customPath?: string): string {
		return findClaudePath(customPath);
	},

	getBinaryPath(customPath?: string): string {
		return getClaudeBinaryPath(customPath);
	},

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

	cleanupTempConfig(tmpDir: string | null): void {
		if (!tmpDir || isPersistentOverlayDir(tmpDir)) {
			return;
		}

		try {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		} catch {
			// Best-effort cleanup
		}
	},

	supportsNodeInterceptor(): boolean {
		return true;
	},
};

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

export { getClaudeBinaryPath, isNativeBinary, resolveToJsFile };
