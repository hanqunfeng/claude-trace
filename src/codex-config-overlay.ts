import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { parse, stringify } from "smol-toml";
import type { OverlaySyncResult } from "./claude-config-overlay";

const CONFIG_FILE = "config.toml";
const RESERVED_BUILTIN_PROVIDERS = new Set(["openai", "ollama", "lmstudio"]);

export interface CodexConfig {
	model?: string;
	model_provider?: string;
	openai_base_url?: string;
	chatgpt_base_url?: string;
	model_providers?: Record<string, CodexModelProvider>;
	[key: string]: unknown;
}

export interface CodexModelProvider {
	name?: string;
	base_url?: string;
	wire_api?: string;
	supports_websockets?: boolean;
	[key: string]: unknown;
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

export function getCodexConfigOverlayDir(): string {
	return path.join(os.homedir(), ".claude-trace", "codex-config-overlay");
}

export function isPersistentCodexOverlayDir(dir: string | null): boolean {
	if (!dir) {
		return false;
	}
	return path.resolve(dir) === path.resolve(getCodexConfigOverlayDir());
}

export function resolveUserCodexHome(env: NodeJS.ProcessEnv = process.env): string {
	return env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

export function resolveCodexConfigPath(codexHome?: string): string | null {
	const home = codexHome || resolveUserCodexHome();
	const configPath = path.join(home, CONFIG_FILE);
	return fs.existsSync(configPath) ? configPath : null;
}

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

export function hasChatGptAuth(codexHome?: string): boolean {
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

function rewriteConfigForProxy(config: CodexConfig, proxyUrl: string): CodexConfig {
	const proxyBase = proxyUrl.replace(/\/$/, "");
	const rewritten: CodexConfig = { ...config };

	rewritten.openai_base_url = proxyBase;
	rewritten.chatgpt_base_url = proxyBase;

	if (config.model_providers) {
		const providers: Record<string, CodexModelProvider> = {};
		for (const [id, provider] of Object.entries(config.model_providers)) {
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

function writeOverlayConfig(overlayDir: string, config: CodexConfig): void {
	fs.mkdirSync(overlayDir, { recursive: true });
	fs.writeFileSync(path.join(overlayDir, CONFIG_FILE), stringify(config));
}

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
			// Skip unparseable profile files
		}
	}
}

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

export { RESERVED_BUILTIN_PROVIDERS };
