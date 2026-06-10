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
} from "../src/claude-config-overlay";

describe("claude-config-overlay", () => {
	it("detects persistent overlay directory", () => {
		assert.equal(isPersistentOverlayDir(getClaudeConfigOverlayDir()), true);
		assert.equal(isPersistentOverlayDir("/tmp/claude-trace-abc"), false);
	});

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
