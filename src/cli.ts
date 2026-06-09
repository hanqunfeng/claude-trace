#!/usr/bin/env node

import { spawn, ChildProcess, execSync } from "child_process";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { HTMLGenerator } from "./html-generator";
import { ReverseProxyServer } from "./reverse-proxy";

// Colors for output
export const colors = {
	red: "\x1b[0;31m",
	green: "\x1b[0;32m",
	yellow: "\x1b[1;33m",
	blue: "\x1b[0;34m",
	reset: "\x1b[0m",
} as const;

type ColorName = keyof typeof colors;

function log(message: string, color: ColorName = "reset"): void {
	console.log(`${colors[color]}${message}${colors.reset}`);
}

function showHelp(): void {
	console.log(`
${colors.blue}Claude Trace${colors.reset}
Record all your interactions with Claude Code as you develop your projects

${colors.yellow}USAGE:${colors.reset}
  claude-trace [OPTIONS] [--run-with CLAUDE_ARG...]

${colors.yellow}OPTIONS:${colors.reset}
  --extract-token    Extract OAuth token and exit (reproduces claude-token.py)
  --generate-html    Generate HTML report from JSONL file
  --index           Generate conversation summaries and index for .claude-trace/ directory
  --run-with         Pass all following arguments to Claude process
  --include-all-requests Include all requests made through fetch, otherwise only requests to v1/messages with more than 2 messages in the context
  --include-sensitive-headers Log sensitive headers (auth tokens, cookies) without redaction
  --no-open          Don't open generated HTML file in browser
  --log              Specify custom log file base name (without extension)
  --claude-path      Specify custom path to Claude binary
  --help, -h         Show this help message

${colors.yellow}MODES:${colors.reset}
  ${colors.green}Interactive logging:${colors.reset}
    claude-trace                               Start Claude with traffic logging
    claude-trace --log my-session              Start Claude with custom log file name
    claude-trace --run-with chat                    Run Claude with specific command
    claude-trace --run-with chat --model sonnet-3.5 Run Claude with multiple arguments

  ${colors.green}Token extraction:${colors.reset}
    claude-trace --extract-token               Extract OAuth token for SDK usage

  ${colors.green}HTML generation:${colors.reset}
    claude-trace --generate-html file.jsonl          Generate HTML from JSONL file
    claude-trace --generate-html file.jsonl out.html Generate HTML with custom output name
    claude-trace --generate-html file.jsonl          Generate HTML and open in browser (default)
    claude-trace --generate-html file.jsonl --no-open Generate HTML without opening browser

  ${colors.green}Indexing:${colors.reset}
    claude-trace --index                             Generate conversation summaries and index

${colors.yellow}EXAMPLES:${colors.reset}
  # Start Claude with logging
  claude-trace

  # Start Claude with custom log file name
  claude-trace --log my-session

  # Run Claude chat with logging
  claude-trace --run-with chat

  # Run Claude with specific model
  claude-trace --run-with chat --model sonnet-3.5

  # Pass multiple arguments to Claude
  claude-trace --run-with --model gpt-4o --temperature 0.7

  # Extract token for Anthropic SDK
  export ANTHROPIC_API_KEY=$(claude-trace --extract-token)

  # Generate HTML report
  claude-trace --generate-html logs/traffic.jsonl report.html

  # Generate HTML report and open in browser (default)
  claude-trace --generate-html logs/traffic.jsonl

  # Generate HTML report without opening browser
  claude-trace --generate-html logs/traffic.jsonl --no-open

  # Generate conversation index
  claude-trace --index

  # Use custom Claude binary path
  claude-trace --claude-path /usr/local/bin/claude

${colors.yellow}OUTPUT:${colors.reset}
  Logs are saved to: ${colors.green}.claude-trace/log-YYYY-MM-DD-HH-MM-SS.{jsonl,html}${colors.reset}
  With --log NAME:   ${colors.green}.claude-trace/NAME.{jsonl,html}${colors.reset}

${colors.yellow}MIGRATION:${colors.reset}
  This tool replaces Python-based claude-logger and claude-token.py scripts
  with a pure Node.js implementation. All output formats are compatible.

For more information, visit: https://github.com/hanqunfeng/claude-trace
`);
}

function resolveToJsFile(filePath: string): string {
	try {
		const realPath = fs.realpathSync(filePath);

		if (realPath.endsWith(".js")) {
			return realPath;
		}

		if (fs.existsSync(realPath)) {
			const content = fs.readFileSync(realPath, "utf-8");
			if (
				content.startsWith("#!/usr/bin/env node") ||
				content.match(/^#!.*\/node$/m) ||
				content.includes("require(") ||
				content.includes("import ")
			) {
				return realPath;
			}
		}

		const possibleJsPaths = [
			realPath + ".js",
			realPath.replace(/\/bin\//, "/lib/") + ".js",
			realPath.replace(/\/\.bin\//, "/lib/bin/") + ".js",
		];

		for (const jsPath of possibleJsPaths) {
			if (fs.existsSync(jsPath)) {
				return jsPath;
			}
		}

		return realPath;
	} catch {
		return filePath;
	}
}

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

function getLoaderPath(): string {
	const loaderPath = path.join(__dirname, "interceptor-loader.js");

	if (!fs.existsSync(loaderPath)) {
		log(`Interceptor loader not found at: ${loaderPath}`, "red");
		process.exit(1);
	}

	return loaderPath;
}

const NATIVE_BINARY_SIGNATURES = {
	ELF: Buffer.from([0x7f, 0x45, 0x4c, 0x46]),
	MACHO_32: Buffer.from([0xfe, 0xed, 0xfa, 0xce]),
	MACHO_64: Buffer.from([0xfe, 0xed, 0xfa, 0xcf]),
	MACHO_32_REV: Buffer.from([0xce, 0xfa, 0xed, 0xfe]),
	MACHO_64_REV: Buffer.from([0xcf, 0xfa, 0xed, 0xfe]),
	MACHO_FAT: Buffer.from([0xca, 0xfe, 0xba, 0xbe]),
	PE: Buffer.from([0x4d, 0x5a]),
} as const;

function isNativeBinary(filePath: string): boolean {
	try {
		const fd = fs.openSync(filePath, "r");
		const buffer = Buffer.alloc(4);
		fs.readSync(fd, buffer, 0, 4, 0);
		fs.closeSync(fd);

		if (buffer.subarray(0, 4).equals(NATIVE_BINARY_SIGNATURES.ELF)) return true;
		if (buffer.subarray(0, 4).equals(NATIVE_BINARY_SIGNATURES.MACHO_32)) return true;
		if (buffer.subarray(0, 4).equals(NATIVE_BINARY_SIGNATURES.MACHO_64)) return true;
		if (buffer.subarray(0, 4).equals(NATIVE_BINARY_SIGNATURES.MACHO_32_REV)) return true;
		if (buffer.subarray(0, 4).equals(NATIVE_BINARY_SIGNATURES.MACHO_64_REV)) return true;
		if (buffer.subarray(0, 4).equals(NATIVE_BINARY_SIGNATURES.MACHO_FAT)) return true;
		if (buffer.subarray(0, 2).equals(NATIVE_BINARY_SIGNATURES.PE)) return true;

		return false;
	} catch {
		return false;
	}
}

function getClaudeConfigDir(): string {
	return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
}

function readUpstreamBaseUrl(): string {
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
}

function prepareClaudeSpawnEnv(proxyUrl: string): { tmpDir: string | null; spawnEnv: NodeJS.ProcessEnv } {
	const settingsPath = path.join(getClaudeConfigDir(), "settings.json");
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
				tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-trace-"));
				const { ANTHROPIC_BASE_URL: _removed, ...restEnv } = settings.env;
				settings.env = restEnv;
				fs.writeFileSync(path.join(tmpDir, "settings.json"), JSON.stringify(settings, null, 2));
				spawnEnv.CLAUDE_CONFIG_DIR = tmpDir;
			}
		} catch (error) {
			const err = error as Error;
			log(`Warning: could not prepare temp Claude config: ${err.message}`, "yellow");
		}
	}

	return { tmpDir, spawnEnv };
}

function cleanupTempClaudeConfig(tmpDir: string | null): void {
	if (!tmpDir) {
		return;
	}

	try {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	} catch {
		// Best-effort cleanup
	}
}

async function runClaudeNativeWithProxy(
	claudePath: string,
	claudeArgs: string[] = [],
	includeAllRequests: boolean = false,
	openInBrowser: boolean = false,
	logBaseName?: string,
	logSensitiveHeaders: boolean = false,
): Promise<void> {
	log("Using reverse proxy mode for native binary", "yellow");

	const upstreamBaseUrl = readUpstreamBaseUrl();
	log(`Upstream API: ${upstreamBaseUrl}`, "blue");
	console.log("");

	const proxy = new ReverseProxyServer({
		logBaseName,
		includeAllRequests,
		openBrowser: openInBrowser,
		logSensitiveHeaders,
		targetBaseUrl: upstreamBaseUrl,
	});

	let proxyInfo: { port: number; url: string };
	let tmpConfigDir: string | null = null;

	const shutdown = (): void => {
		proxy.stop();
		cleanupTempClaudeConfig(tmpConfigDir);
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

	const { tmpDir, spawnEnv } = prepareClaudeSpawnEnv(proxyInfo.url);
	tmpConfigDir = tmpDir;

	if (tmpConfigDir) {
		log("Using temporary Claude config (original settings.json unchanged)", "blue");
	}

	const child: ChildProcess = spawn(claudePath, claudeArgs, {
		env: spawnEnv,
		stdio: "inherit",
		cwd: process.cwd(),
	});

	child.on("error", (error: Error) => {
		shutdown();
		log(`Error starting Claude: ${error.message}`, "red");
		process.exit(1);
	});

	child.on("exit", (code: number | null, signal: string | null) => {
		shutdown();

		if (signal) {
			log(`\nClaude terminated by signal: ${signal}`, "yellow");
		} else if (code !== 0 && code !== null) {
			log(`\nClaude exited with code: ${code}`, "yellow");
		} else {
			log("\nClaude session completed", "green");
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
}

async function runClaudeWithInterception(
	claudeArgs: string[] = [],
	includeAllRequests: boolean = false,
	openInBrowser: boolean = false,
	customClaudePath?: string,
	logBaseName?: string,
	logSensitiveHeaders: boolean = false,
): Promise<void> {
	log("Claude Trace", "blue");
	log("Starting Claude with traffic logging", "yellow");
	if (claudeArgs.length > 0) {
		log(`Claude arguments: ${claudeArgs.join(" ")}`, "blue");
	}
	console.log("");

	const claudePath = getClaudeBinaryPath(customClaudePath);
	log(`Using Claude binary: ${claudePath}`, "blue");

	if (isNativeBinary(claudePath)) {
		log("Detected native binary", "yellow");
		await runClaudeNativeWithProxy(
			claudePath,
			claudeArgs,
			includeAllRequests,
			openInBrowser,
			logBaseName,
			logSensitiveHeaders,
		);
		return;
	}

	const jsPath = resolveToJsFile(claudePath);
	const loaderPath = getLoaderPath();

	log(`Using JavaScript entry: ${jsPath}`, "blue");
	log("Starting traffic logger...", "green");
	console.log("");

	const spawnArgs = ["--require", loaderPath, jsPath, ...claudeArgs];
	const child: ChildProcess = spawn("node", spawnArgs, {
		env: {
			...process.env,
			NODE_OPTIONS: "--no-deprecation",
			CLAUDE_TRACE_INCLUDE_ALL_REQUESTS: includeAllRequests ? "true" : "false",
			CLAUDE_TRACE_OPEN_BROWSER: openInBrowser ? "true" : "false",
			...(logBaseName ? { CLAUDE_TRACE_LOG_NAME: logBaseName } : {}),
		},
		stdio: "inherit",
		cwd: process.cwd(),
	});

	child.on("error", (error: Error) => {
		log(`Error starting Claude: ${error.message}`, "red");
		process.exit(1);
	});

	child.on("exit", (code: number | null, signal: string | null) => {
		if (signal) {
			log(`\nClaude terminated by signal: ${signal}`, "yellow");
		} else if (code !== 0 && code !== null) {
			log(`\nClaude exited with code: ${code}`, "yellow");
		} else {
			log("\nClaude session completed", "green");
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

async function extractToken(customClaudePath?: string): Promise<void> {
	const claudePath = getClaudeAbsolutePath(customClaudePath);

	console.error(`Using Claude binary: ${claudePath}`);

	const claudeTraceDir = path.join(process.cwd(), ".claude-trace");
	if (!fs.existsSync(claudeTraceDir)) {
		fs.mkdirSync(claudeTraceDir, { recursive: true });
	}

	const tokenFile = path.join(claudeTraceDir, "token.txt");
	const tokenExtractorPath = path.join(__dirname, "token-extractor.js");

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

async function generateHTMLFromCLI(
	inputFile: string,
	outputFile?: string,
	includeAllRequests: boolean = false,
	openInBrowser: boolean = false,
): Promise<void> {
	try {
		const htmlGenerator = new HTMLGenerator();
		const finalOutputFile = await htmlGenerator.generateHTMLFromJSONL(inputFile, outputFile, includeAllRequests);

		if (openInBrowser) {
			if (process.platform === "win32") {
				spawn("cmd", ["/c", "start", "", finalOutputFile], { detached: true, stdio: "ignore" }).unref();
			} else {
				spawn("open", [finalOutputFile], { detached: true, stdio: "ignore" }).unref();
			}
			log(`Opening ${finalOutputFile} in browser`, "green");
		}

		process.exit(0);
	} catch (error) {
		const err = error as Error;
		log(`Error: ${err.message}`, "red");
		process.exit(1);
	}
}

async function generateIndex(): Promise<void> {
	try {
		const { IndexGenerator } = await import("./index-generator");
		const indexGenerator = new IndexGenerator();
		await indexGenerator.generateIndex();
		process.exit(0);
	} catch (error) {
		const err = error as Error;
		log(`Error: ${err.message}`, "red");
		process.exit(1);
	}
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);

	const argIndex = args.indexOf("--run-with");
	let claudeTraceArgs: string[];
	let claudeArgs: string[];

	if (argIndex !== -1) {
		claudeTraceArgs = args.slice(0, argIndex);
		claudeArgs = args.slice(argIndex + 1);
	} else {
		claudeTraceArgs = args;
		claudeArgs = [];
	}

	if (claudeTraceArgs.includes("--help") || claudeTraceArgs.includes("-h")) {
		showHelp();
		process.exit(0);
	}

	const includeAllRequests = claudeTraceArgs.includes("--include-all-requests");
	const openInBrowser = !claudeTraceArgs.includes("--no-open");
	const logSensitiveHeaders = claudeTraceArgs.includes("--include-sensitive-headers");

	let customClaudePath: string | undefined;
	const claudePathIndex = claudeTraceArgs.indexOf("--claude-path");
	if (claudePathIndex !== -1 && claudeTraceArgs[claudePathIndex + 1]) {
		customClaudePath = claudeTraceArgs[claudePathIndex + 1];
	}

	let logBaseName: string | undefined;
	const logIndex = claudeTraceArgs.indexOf("--log");
	if (logIndex !== -1 && claudeTraceArgs[logIndex + 1]) {
		logBaseName = claudeTraceArgs[logIndex + 1];
	}

	if (claudeTraceArgs.includes("--extract-token")) {
		await extractToken(customClaudePath);
		return;
	}

	if (claudeTraceArgs.includes("--generate-html")) {
		const flagIndex = claudeTraceArgs.indexOf("--generate-html");
		const inputFile = claudeTraceArgs[flagIndex + 1];

		let outputFile: string | undefined;
		for (let i = flagIndex + 2; i < claudeTraceArgs.length; i++) {
			const arg = claudeTraceArgs[i];
			if (!arg.startsWith("--")) {
				outputFile = arg;
				break;
			}
		}

		if (!inputFile) {
			log(`Missing input file for --generate-html`, "red");
			log(`Usage: claude-trace --generate-html input.jsonl [output.html]`, "yellow");
			process.exit(1);
		}

		await generateHTMLFromCLI(inputFile, outputFile, includeAllRequests, openInBrowser);
		return;
	}

	if (claudeTraceArgs.includes("--index")) {
		await generateIndex();
		return;
	}

	await runClaudeWithInterception(
		claudeArgs,
		includeAllRequests,
		openInBrowser,
		customClaudePath,
		logBaseName,
		logSensitiveHeaders,
	);
}

main().catch((error) => {
	const err = error as Error;
	log(`Unexpected error: ${err.message}`, "red");
	process.exit(1);
});
