/**
 * @file Persistent Codex CLI config overlay for reverse-proxy interception.
 *
 * Codex reads API base URLs from `$CODEX_HOME/config.toml` and optional profile
 * files (`*.config.toml`). This module builds a writable overlay at
 * `~/.claude-trace/codex-config-overlay/` that rewrites all base URLs to the local
 * trace proxy while symlinking auth and other non-config files from the real
 * `$CODEX_HOME`. WebSocket support is disabled in custom providers for MVP logging.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { parse, stringify } from "smol-toml";
import type { OverlaySyncResult } from "./claude-config-overlay";

/** Primary Codex configuration filename within `$CODEX_HOME`. */
const CONFIG_FILE = "config.toml";

/**
 * Built-in Codex provider ids whose base URLs are managed by Codex itself.
 * Custom providers in `model_providers` are rewritten; these are skipped.
 */
const RESERVED_BUILTIN_PROVIDERS = new Set(["openai", "ollama", "lmstudio"]);

/** Parsed shape of Codex `config.toml` relevant to proxy rewriting. */
export interface CodexConfig {
	/** Default model identifier. */
	model?: string;
	/** Active model provider id. */
	model_provider?: string;
	/** OpenAI API key auth base URL (typically `/v1/responses`). */
	openai_base_url?: string;
	/** ChatGPT OAuth base URL (typically `/backend-api/codex/responses`). */
	chatgpt_base_url?: string;
	/** User-defined custom model providers keyed by provider id. */
	model_providers?: Record<string, CodexModelProvider>;
	/** Additional TOML keys preserved through parse/stringify round-trips. */
	[key: string]: unknown;
}

/** Parsed shape of Codex `auth.json` fields used for proxy routing. */
export interface CodexAuth {
	/** Active auth mode when present (e.g. `"chatgpt"` for ChatGPT OAuth). */
	auth_mode?: string;
	/** OpenAI API key when using API-key auth; `null` under ChatGPT OAuth. */
	OPENAI_API_KEY?: string | null;
	/** Additional auth file keys preserved through parse round-trips. */
	[key: string]: unknown;
}

/** A custom model provider entry within `model_providers`. */
export interface CodexModelProvider {
	/** Human-readable provider name. */
	name?: string;
	/** Upstream API base URL for this provider. */
	base_url?: string;
	/** Wire protocol identifier (e.g. OpenAI-compatible). */
	wire_api?: string;
	/** Whether the provider supports WebSocket streaming. */
	supports_websockets?: boolean;
	/** Additional provider-specific TOML keys. */
	[key: string]: unknown;
}

/**
 * Creates a directory symlink (junction on Windows, dir symlink elsewhere).
 *
 * @param sourcePath - Existing directory to link from.
 * @param overlayPath - Destination path inside the overlay.
 */
function linkDirectory(sourcePath: string, overlayPath: string): void {
	const absoluteSource = path.resolve(sourcePath);
	if (process.platform === "win32") {
		fs.symlinkSync(absoluteSource, overlayPath, "junction");
		return;
	}
	fs.symlinkSync(absoluteSource, overlayPath, "dir");
}

/**
 * Symlinks a file, falling back to copy when symlink creation fails.
 *
 * @param sourcePath - Existing file in the user's real `$CODEX_HOME`.
 * @param overlayPath - Destination path inside the overlay.
 */
function linkOrCopyFile(sourcePath: string, overlayPath: string): void {
	try {
		if (process.platform === "win32") {
			fs.symlinkSync(path.resolve(sourcePath), overlayPath, "file");
		} else {
			fs.symlinkSync(sourcePath, overlayPath, "file");
		}
	} catch {
		fs.copyFileSync(sourcePath, overlayPath);
	}
}

/**
 * Links a file or directory into the overlay if the destination does not exist.
 *
 * @param sourcePath - Path to the source file or directory.
 * @param overlayPath - Corresponding path inside the overlay directory.
 */
function linkEntry(sourcePath: string, overlayPath: string): void {
	if (fs.existsSync(overlayPath)) {
		return;
	}

	const stat = fs.lstatSync(sourcePath);
	if (stat.isDirectory()) {
		linkDirectory(sourcePath, overlayPath);
		return;
	}
	linkOrCopyFile(sourcePath, overlayPath);
}

/**
 * Attempts to link one entry and records the outcome in `result`.
 *
 * @param entryLabel - Human-readable name recorded in the sync result.
 * @param sourcePath - Source file or directory path.
 * @param overlayPath - Destination path inside the overlay.
 * @param result - Mutable sync result accumulator.
 */
function tryLinkEntryWithResult(
	entryLabel: string,
	sourcePath: string,
	overlayPath: string,
	result: OverlaySyncResult,
): void {
	if (!fs.existsSync(sourcePath)) {
		return;
	}

	try {
		linkEntry(sourcePath, overlayPath);
		result.linked.push(entryLabel);
	} catch (error) {
		const err = error as Error;
		result.skipped.push({ entry: entryLabel, reason: err.message });
	}
}

/**
 * Returns the persistent overlay directory path for Codex config.
 *
 * @returns Absolute path under `~/.claude-trace/codex-config-overlay/`.
 */
export function getCodexConfigOverlayDir(): string {
	return path.join(os.homedir(), ".claude-trace", "codex-config-overlay");
}

/**
 * Returns true when `dir` is the canonical persistent Codex overlay directory.
 *
 * @param dir - Directory path to check, or `null`.
 */
export function isPersistentCodexOverlayDir(dir: string | null): boolean {
	if (!dir) {
		return false;
	}
	return path.resolve(dir) === path.resolve(getCodexConfigOverlayDir());
}

/**
 * Resolves the user's real Codex home directory.
 *
 * @param env - Environment map; defaults to `process.env`.
 * @returns `CODEX_HOME` if set, otherwise `~/.codex`.
 */
export function resolveUserCodexHome(env: NodeJS.ProcessEnv = process.env): string {
	return env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

/**
 * Returns the path to `config.toml` if it exists, otherwise `null`.
 *
 * @param codexHome - Codex home directory; defaults to {@link resolveUserCodexHome}.
 */
export function resolveCodexConfigPath(codexHome?: string): string | null {
	const home = codexHome || resolveUserCodexHome();
	const configPath = path.join(home, CONFIG_FILE);
	return fs.existsSync(configPath) ? configPath : null;
}

/**
 * Reads and parses Codex `config.toml`, returning an empty object on missing/error.
 *
 * @param codexHome - Codex home directory; defaults to {@link resolveUserCodexHome}.
 */
export function readCodexConfig(codexHome?: string): CodexConfig {
	const configPath = resolveCodexConfigPath(codexHome);
	if (!configPath) {
		return {};
	}

	try {
		return parse(fs.readFileSync(configPath, "utf-8")) as CodexConfig;
	} catch {
		return {};
	}
}

/**
 * Reads and parses Codex `auth.json`, returning `null` when missing or invalid.
 *
 * @param codexHome - Codex home directory; defaults to {@link resolveUserCodexHome}.
 */
export function readCodexAuth(codexHome?: string): CodexAuth | null {
	const home = codexHome || resolveUserCodexHome();
	const authPath = path.join(home, "auth.json");
	if (!fs.existsSync(authPath)) {
		return null;
	}

	try {
		return JSON.parse(fs.readFileSync(authPath, "utf-8")) as CodexAuth;
	} catch {
		return null;
	}
}

/**
 * Returns true when `auth.json` explicitly selects ChatGPT OAuth.
 *
 * Only checks the `auth_mode` field when it is present; older auth files
 * without `auth_mode` fall through to {@link hasChatGptAuth} heuristics.
 *
 * @param codexHome - Codex home directory; defaults to {@link resolveUserCodexHome}.
 */
export function isChatGptAuthMode(codexHome?: string): boolean {
	const auth = readCodexAuth(codexHome);
	return auth?.auth_mode === "chatgpt";
}

/**
 * Detects whether the user has ChatGPT OAuth credentials (vs OpenAI API key auth).
 *
 * Prefers an explicit `auth_mode: "chatgpt"` in `auth.json`. When `auth_mode` is
 * absent, falls back to a legacy content heuristic for older Codex installs.
 *
 * @param codexHome - Codex home directory; defaults to {@link resolveUserCodexHome}.
 */
export function hasChatGptAuth(codexHome?: string): boolean {
	if (isChatGptAuthMode(codexHome)) {
		return true;
	}

	const auth = readCodexAuth(codexHome);
	if (auth && "auth_mode" in auth) {
		// Explicit non-ChatGPT auth_mode — do not apply legacy heuristics.
		return false;
	}

	const home = codexHome || resolveUserCodexHome();
	const authPath = path.join(home, "auth.json");
	if (!fs.existsSync(authPath)) {
		return false;
	}

	try {
		const raw = fs.readFileSync(authPath, "utf-8");
		return /chatgpt|chat\.openai/i.test(raw);
	} catch {
		return false;
	}
}

/**
 * Rewrites all API base URLs in a Codex config to point at the local trace proxy.
 *
 * Sets `openai_base_url` and `chatgpt_base_url` to `proxyUrl`, rewrites custom
 * `model_providers` base URLs, and disables WebSockets (not yet supported for logging).
 *
 * @param config - Parsed Codex configuration to rewrite.
 * @param proxyUrl - Local trace proxy base URL (e.g. `http://127.0.0.1:PORT`).
 * @returns New config object with proxy URLs applied.
 */
function rewriteConfigForProxy(config: CodexConfig, proxyUrl: string): CodexConfig {
	const proxyBase = proxyUrl.replace(/\/$/, "");
	const rewritten: CodexConfig = { ...config };

	rewritten.openai_base_url = proxyBase;
	rewritten.chatgpt_base_url = proxyBase;

	if (config.model_providers) {
		const providers: Record<string, CodexModelProvider> = {};
		for (const [id, provider] of Object.entries(config.model_providers)) {
			// Built-in providers use Codex-internal routing; only custom providers are rewritten.
			if (RESERVED_BUILTIN_PROVIDERS.has(id)) {
				continue;
			}
			providers[id] = {
				...provider,
				base_url: proxyBase,
				supports_websockets: false,
			};
		}
		rewritten.model_providers = providers;
	}

	return rewritten;
}

/**
 * Writes the rewritten main `config.toml` into the overlay directory.
 *
 * @param overlayDir - Writable overlay directory.
 * @param config - Rewritten configuration to persist.
 */
function writeOverlayConfig(overlayDir: string, config: CodexConfig): void {
	fs.mkdirSync(overlayDir, { recursive: true });
	fs.writeFileSync(path.join(overlayDir, CONFIG_FILE), stringify(config));
}

/**
 * Rewrites and copies all `*.config.toml` profile files into the overlay.
 *
 * Codex supports named profiles as separate TOML files alongside the main config.
 *
 * @param sourceHome - User's real `$CODEX_HOME` directory.
 * @param overlayDir - Writable overlay directory.
 * @param proxyUrl - Local trace proxy base URL.
 */
function syncProfileConfigs(sourceHome: string, overlayDir: string, proxyUrl: string): void {
	if (!fs.existsSync(sourceHome)) {
		return;
	}

	for (const entry of fs.readdirSync(sourceHome)) {
		if (!entry.endsWith(".config.toml")) {
			continue;
		}

		const sourcePath = path.join(sourceHome, entry);
		try {
			const profileConfig = parse(fs.readFileSync(sourcePath, "utf-8")) as CodexConfig;
			const rewritten = rewriteConfigForProxy(profileConfig, proxyUrl);
			fs.writeFileSync(path.join(overlayDir, entry), stringify(rewritten));
		} catch {
			// Skip unparseable profile files rather than failing the whole overlay sync.
		}
	}
}

/**
 * Builds or refreshes the Codex config overlay.
 *
 * 1. Rewrites main `config.toml` and all `*.config.toml` profiles with proxy URLs.
 * 2. Symlinks remaining `$CODEX_HOME` entries (auth, sessions, etc.) into the overlay.
 *
 * @param sourceHome - User's real `$CODEX_HOME` directory.
 * @param overlayDir - Writable overlay directory to populate.
 * @param proxyUrl - Local trace proxy base URL (e.g. `http://127.0.0.1:PORT`).
 * @returns Summary of linked and skipped non-config entries.
 */
export function syncCodexConfigOverlay(
	sourceHome: string,
	overlayDir: string,
	proxyUrl: string,
): OverlaySyncResult {
	const result: OverlaySyncResult = { linked: [], skipped: [] };

	fs.mkdirSync(overlayDir, { recursive: true });

	const sourceConfig = readCodexConfig(sourceHome);
	const rewritten = rewriteConfigForProxy(sourceConfig, proxyUrl);
	writeOverlayConfig(overlayDir, rewritten);
	syncProfileConfigs(sourceHome, overlayDir, proxyUrl);

	if (fs.existsSync(sourceHome)) {
		for (const entry of fs.readdirSync(sourceHome)) {
			// Config files are rewritten above; everything else is symlinked.
			if (entry === CONFIG_FILE || entry.endsWith(".config.toml")) {
				continue;
			}
			tryLinkEntryWithResult(
				entry,
				path.join(sourceHome, entry),
				path.join(overlayDir, entry),
				result,
			);
		}
	}

	return result;
}

/** Built-in Codex provider ids excluded from proxy URL rewriting. */
export { RESERVED_BUILTIN_PROVIDERS };
