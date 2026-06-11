/**
 * @file Persistent Claude Code config overlay for reverse-proxy interception.
 *
 * When the user's `~/.claude/settings.json` defines its own `ANTHROPIC_BASE_URL`,
 * setting the env var alone is insufficient — Claude Code prefers settings over env.
 * This module builds a writable overlay at `~/.claude-trace/claude-config-overlay/`
 * that symlinks all config entries except `settings.json`, which is rewritten to
 * strip `ANTHROPIC_BASE_URL` so the trace runner's proxy URL takes effect.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/** Filename of Claude Code's primary settings file within the config directory. */
const SETTINGS_FILE = "settings.json";

/** Result of syncing source config entries into the overlay directory. */
export interface OverlaySyncResult {
	/** Entry names successfully linked into the overlay. */
	linked: string[];
	/** Entries that could not be linked, with error reasons. */
	skipped: Array<{ entry: string; reason: string }>;
}

/**
 * Returns the persistent overlay directory path for Claude Code config.
 *
 * @returns Absolute path under `~/.claude-trace/claude-config-overlay/`.
 */
export function getClaudeConfigOverlayDir(): string {
	return path.join(os.homedir(), ".claude-trace", "claude-config-overlay");
}

/**
 * Returns true when `dir` is the canonical persistent overlay directory.
 *
 * Used to avoid deleting or recreating an overlay that is already in use.
 *
 * @param dir - Directory path to check, or `null`.
 */
export function isPersistentOverlayDir(dir: string | null): boolean {
	if (!dir) {
		return false;
	}
	return path.resolve(dir) === path.resolve(getClaudeConfigOverlayDir());
}

/**
 * Resolves the user's real Claude Code config directory.
 *
 * @param env - Environment map; defaults to `process.env`.
 * @returns `CLAUDE_CONFIG_DIR` if set, otherwise `~/.claude`.
 */
export function resolveUserClaudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
	return env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
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
		// Junctions work without admin privileges on Windows for directories.
		fs.symlinkSync(absoluteSource, overlayPath, "junction");
		return;
	}
	fs.symlinkSync(absoluteSource, overlayPath, "dir");
}

/**
 * Symlinks a file into the overlay, falling back to a plain copy on failure.
 *
 * Symlink creation may fail on Windows without Developer Mode; copy preserves behavior.
 *
 * @param sourcePath - Existing file in the user's real config directory.
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
 * Links a single source entry (file or directory) into the overlay if not present.
 *
 * Skips silently when the overlay entry already exists to preserve idempotency.
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
 * Attempts to link one entry and records success or failure in `result`.
 *
 * Missing source files are ignored (not an error — optional config entries).
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
 * Links Claude home-level state files that live outside the config directory.
 *
 * These files (`.claude.json`, `.credentials.json`) are required for auth and
 * session state but are not inside `~/.claude/`.
 *
 * @param overlayDir - Overlay directory receiving the links.
 * @param homeDir - User home directory containing the state files.
 * @param result - Mutable sync result accumulator.
 */
function linkHomeStateFiles(overlayDir: string, homeDir: string, result: OverlaySyncResult): void {
	for (const fileName of [".claude.json", ".credentials.json"]) {
		tryLinkEntryWithResult(fileName, path.join(homeDir, fileName), path.join(overlayDir, fileName), result);
	}
}

/**
 * Builds or refreshes the Claude config overlay by symlinking source entries.
 *
 * All entries from `sourceConfigDir` are linked except `settings.json`, which
 * is handled separately by {@link writeOverlaySettings}. Home-level state files
 * are also linked when present.
 *
 * @param sourceConfigDir - User's real Claude config directory (`~/.claude`).
 * @param overlayDir - Writable overlay directory to populate.
 * @param homeDir - User home directory for `.claude.json` / `.credentials.json`.
 * @returns Summary of linked and skipped entries.
 */
export function syncClaudeConfigOverlay(
	sourceConfigDir: string,
	overlayDir: string,
	homeDir: string,
): OverlaySyncResult {
	const result: OverlaySyncResult = { linked: [], skipped: [] };

	fs.mkdirSync(overlayDir, { recursive: true });

	if (fs.existsSync(sourceConfigDir)) {
		for (const entry of fs.readdirSync(sourceConfigDir)) {
			// settings.json is rewritten separately to remove ANTHROPIC_BASE_URL.
			if (entry === SETTINGS_FILE) {
				continue;
			}
			tryLinkEntryWithResult(
				entry,
				path.join(sourceConfigDir, entry),
				path.join(overlayDir, entry),
				result,
			);
		}
	}

	linkHomeStateFiles(overlayDir, homeDir, result);

	return result;
}

/**
 * Writes a modified `settings.json` into the overlay, stripping `ANTHROPIC_BASE_URL`.
 *
 * Claude Code reads `settings.json` env overrides with higher priority than process
 * environment variables. Removing `ANTHROPIC_BASE_URL` from settings ensures the
 * trace runner's `ANTHROPIC_BASE_URL=http://127.0.0.1:{port}` proxy URL wins.
 *
 * @param sourceSettingsPath - Path to the user's original `settings.json`.
 * @param overlayDir - Overlay directory to write the modified settings into.
 * @returns Paths needed to spawn Claude with `CLAUDE_CONFIG_DIR` pointing at the overlay.
 */
export function writeOverlaySettings(
	sourceSettingsPath: string,
	overlayDir: string,
): { overlayDir: string; spawnClaudeConfigDir: string } {
	const settings = JSON.parse(fs.readFileSync(sourceSettingsPath, "utf-8")) as {
		env?: Record<string, string>;
	};

	if (settings.env?.ANTHROPIC_BASE_URL) {
		const { ANTHROPIC_BASE_URL: _removed, ...restEnv } = settings.env;
		settings.env = restEnv;
	}

	fs.mkdirSync(overlayDir, { recursive: true });
	fs.writeFileSync(path.join(overlayDir, SETTINGS_FILE), JSON.stringify(settings, null, 2));

	return {
		overlayDir,
		spawnClaudeConfigDir: overlayDir,
	};
}
