/**
 * @file claude-config-overlay.test.ts
 *
 * Unit tests for Claude Code V2+ config overlay used in reverse-proxy mode.
 *
 * When Claude Code runs as a native binary, claude-trace cannot inject a
 * Node.js `--require` interceptor. Instead it starts a local reverse proxy and
 * sets `ANTHROPIC_BASE_URL` to point at it. If the user's `~/.claude/settings.json`
 * also defines `ANTHROPIC_BASE_URL`, that value would override the proxy env var.
 *
 * To avoid modifying the original config, `claude-config-overlay.ts` builds a
 * persistent overlay directory at `~/.claude-trace/claude-config-overlay/` that:
 * - Symlinks (or junctions on Windows) all non-settings files from the source dir
 * - Writes a sanitized `settings.json` with `ANTHROPIC_BASE_URL` removed from `env`
 *
 * This suite covers overlay directory detection, settings sanitization, symlink
 * sync, and partial overlay behavior when the source config directory is missing.
 *
 * @see ../src/claude-config-overlay.ts — overlay sync implementation
 * @see ../src/cli/trace-runner.ts — selects overlay vs direct env injection at launch
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
	getClaudeConfigOverlayDir,
	isPersistentOverlayDir,
	syncClaudeConfigOverlay,
	writeOverlaySettings,
} from "../src/config/claude-config-overlay";

/**
 * End-to-end overlay behavior: persistent directory detection, settings rewrite,
 * directory sync, and graceful handling of missing source config.
 */
describe("claude-config-overlay", () => {
	/**
	 * Only the canonical `~/.claude-trace/claude-config-overlay/` path is
	 * treated as a persistent overlay; ephemeral temp dirs must not qualify.
	 */
	it("detects persistent overlay directory", () => {
		assert.equal(isPersistentOverlayDir(getClaudeConfigOverlayDir()), true);
		assert.equal(isPersistentOverlayDir("/tmp/claude-trace-abc"), false);
	});

	/**
	 * Overlay settings must strip `ANTHROPIC_BASE_URL` from the `env` block so
	 * the proxy URL injected via process environment takes effect. Other env
	 * entries should be preserved unchanged.
	 */
	it("writes settings without ANTHROPIC_BASE_URL", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-overlay-test-"));
		const sourceDir = path.join(root, "source");
		const overlayDir = path.join(root, "overlay");
		fs.mkdirSync(sourceDir, { recursive: true });

		const settingsPath = path.join(sourceDir, "settings.json");
		fs.writeFileSync(
			settingsPath,
			JSON.stringify({
				model: "sonnet",
				env: {
					ANTHROPIC_BASE_URL: "https://gateway.example.com",
					OTHER: "keep-me",
				},
			}),
		);

		writeOverlaySettings(settingsPath, overlayDir);

		const written = JSON.parse(fs.readFileSync(path.join(overlayDir, "settings.json"), "utf-8")) as {
			env?: Record<string, string>;
		};
		assert.equal(written.env?.ANTHROPIC_BASE_URL, undefined);
		assert.equal(written.env?.OTHER, "keep-me");
	});

	/**
	 * During sync, non-settings files and directories are linked into the overlay
	 * so Claude Code sees the same plugins and history. `settings.json` is excluded
	 * from linking because it is written separately with sanitized content.
	 */
	it("links source entries except settings.json", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-overlay-sync-"));
		const sourceDir = path.join(root, "source");
		const overlayDir = path.join(root, "overlay");
		fs.mkdirSync(sourceDir, { recursive: true });
		fs.mkdirSync(path.join(sourceDir, "plugins"), { recursive: true });
		fs.writeFileSync(path.join(sourceDir, "settings.json"), "{}");
		fs.writeFileSync(path.join(sourceDir, "history.jsonl"), "line\n");

		const result = syncClaudeConfigOverlay(sourceDir, overlayDir, root);

		assert.equal(fs.existsSync(path.join(overlayDir, "plugins")), true);
		assert.equal(fs.existsSync(path.join(overlayDir, "history.jsonl")), true);
		assert.equal(fs.existsSync(path.join(overlayDir, "settings.json")), false);
		assert.equal(result.skipped.length, 0);
	});

	/**
	 * Overlay sync tolerates a missing source config directory (no symlinks created).
	 * Settings can still be written from a standalone settings file path, enabling
	 * partial overlay when only settings need sanitization.
	 */
	it("still writes settings when source config dir is missing", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-overlay-partial-"));
		const sourceDir = path.join(root, "missing-source");
		const overlayDir = path.join(root, "overlay");
		const settingsPath = path.join(root, "settings.json");
		fs.writeFileSync(
			settingsPath,
			JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://gateway.example.com", KEEP: "1" } }),
		);

		const result = syncClaudeConfigOverlay(sourceDir, overlayDir, root);
		writeOverlaySettings(settingsPath, overlayDir);

		assert.equal(result.linked.length, 0);
		assert.equal(fs.existsSync(path.join(overlayDir, "settings.json")), true);
		const written = JSON.parse(fs.readFileSync(path.join(overlayDir, "settings.json"), "utf-8")) as {
			env?: Record<string, string>;
		};
		assert.equal(written.env?.ANTHROPIC_BASE_URL, undefined);
		assert.equal(written.env?.KEEP, "1");
	});
});
