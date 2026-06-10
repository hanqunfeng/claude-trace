import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const SETTINGS_FILE = "settings.json";

export interface OverlaySyncResult {
	linked: string[];
	skipped: Array<{ entry: string; reason: string }>;
}

export function getClaudeConfigOverlayDir(): string {
	return path.join(os.homedir(), ".claude-trace", "claude-config-overlay");
}

export function isPersistentOverlayDir(dir: string | null): boolean {
	if (!dir) {
		return false;
	}
	return path.resolve(dir) === path.resolve(getClaudeConfigOverlayDir());
}

export function resolveUserClaudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
	return env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
}

function linkDirectory(sourcePath: string, overlayPath: string): void {
	const absoluteSource = path.resolve(sourcePath);
	if (process.platform === "win32") {
		fs.symlinkSync(absoluteSource, overlayPath, "junction");
		return;
	}
	fs.symlinkSync(absoluteSource, overlayPath, "dir");
}

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

function linkHomeStateFiles(overlayDir: string, homeDir: string, result: OverlaySyncResult): void {
	for (const fileName of [".claude.json", ".credentials.json"]) {
		tryLinkEntryWithResult(fileName, path.join(homeDir, fileName), path.join(overlayDir, fileName), result);
	}
}

export function syncClaudeConfigOverlay(
	sourceConfigDir: string,
	overlayDir: string,
	homeDir: string,
): OverlaySyncResult {
	const result: OverlaySyncResult = { linked: [], skipped: [] };

	fs.mkdirSync(overlayDir, { recursive: true });

	if (fs.existsSync(sourceConfigDir)) {
		for (const entry of fs.readdirSync(sourceConfigDir)) {
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
