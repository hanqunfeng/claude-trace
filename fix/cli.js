#!/usr/bin/env node
"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.colors = void 0;
const child_process_1 = require("child_process");
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const html_generator_1 = require("./html-generator");
const reverse_proxy_1 = require("./reverse-proxy");
// Colors for output
exports.colors = {
    red: "\x1b[0;31m",
    green: "\x1b[0;32m",
    yellow: "\x1b[1;33m",
    blue: "\x1b[0;34m",
    reset: "\x1b[0m",
};
function log(message, color = "reset") {
    console.log(`${exports.colors[color]}${message}${exports.colors.reset}`);
}
function showHelp() {
    console.log(`
${exports.colors.blue}Claude Trace${exports.colors.reset}
Record all your interactions with Claude Code as you develop your projects

${exports.colors.yellow}USAGE:${exports.colors.reset}
  claude-trace [OPTIONS] [--run-with CLAUDE_ARG...]

${exports.colors.yellow}OPTIONS:${exports.colors.reset}
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

${exports.colors.yellow}MODES:${exports.colors.reset}
  ${exports.colors.green}Interactive logging:${exports.colors.reset}
    claude-trace                               Start Claude with traffic logging
    claude-trace --log my-session              Start Claude with custom log file name
    claude-trace --run-with chat                    Run Claude with specific command
    claude-trace --run-with chat --model sonnet-3.5 Run Claude with multiple arguments

  ${exports.colors.green}Token extraction:${exports.colors.reset}
    claude-trace --extract-token               Extract OAuth token for SDK usage

  ${exports.colors.green}HTML generation:${exports.colors.reset}
    claude-trace --generate-html file.jsonl          Generate HTML from JSONL file
    claude-trace --generate-html file.jsonl out.html Generate HTML with custom output name
    claude-trace --generate-html file.jsonl          Generate HTML and open in browser (default)
    claude-trace --generate-html file.jsonl --no-open Generate HTML without opening browser

  ${exports.colors.green}Indexing:${exports.colors.reset}
    claude-trace --index                             Generate conversation summaries and index

${exports.colors.yellow}EXAMPLES:${exports.colors.reset}
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

${exports.colors.yellow}OUTPUT:${exports.colors.reset}
  Logs are saved to: ${exports.colors.green}.claude-trace/log-YYYY-MM-DD-HH-MM-SS.{jsonl,html}${exports.colors.reset}
  With --log NAME:   ${exports.colors.green}.claude-trace/NAME.{jsonl,html}${exports.colors.reset}

${exports.colors.yellow}MIGRATION:${exports.colors.reset}
  This tool replaces Python-based claude-logger and claude-token.py scripts
  with a pure Node.js implementation. All output formats are compatible.

For more information, visit: https://github.com/mariozechner/claude-trace
`);
}
function resolveToJsFile(filePath) {
    try {
        const realPath = fs.realpathSync(filePath);
        if (realPath.endsWith(".js")) {
            return realPath;
        }
        if (fs.existsSync(realPath)) {
            const content = fs.readFileSync(realPath, "utf-8");
            if (content.startsWith("#!/usr/bin/env node") ||
                content.match(/^#!.*\/node$/m) ||
                content.includes("require(") ||
                content.includes("import ")) {
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
    }
    catch (error) {
        return filePath;
    }
}

// Shared logic to find Claude binary path (cross-platform)
function findClaudePath(customPath) {
    if (customPath) {
        if (!fs.existsSync(customPath)) {
            log(`Claude binary not found at specified path: ${customPath}`, "red");
            process.exit(1);
        }
        return customPath;
    }
    const os = require("os");
    const isWindows = process.platform === "win32";
    try {
        const findCmd = isWindows ? "where.exe claude" : "which claude";
        let claudePath = require("child_process")
            .execSync(findCmd, { encoding: "utf-8" })
            .trim()
            .split(/\r?\n/)[0];
        // Convert MSYS/Git Bash paths (e.g. /c/Users/...) to Windows paths (C:/Users/...)
        const msysMatch = claudePath.match(/^\/([a-zA-Z])\//);
        if (msysMatch) {
            claudePath = msysMatch[1].toUpperCase() + ":/" + claudePath.slice(3);
        }
        // Handle shell aliases (e.g., "claude: aliased to /path/to/claude")
        const aliasMatch = claudePath.match(/:\s*aliased to\s+(.+)$/);
        if (aliasMatch && aliasMatch[1]) {
            claudePath = aliasMatch[1];
        }
        return claudePath;
    } catch {
        // Check common installation locations
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

// Resolve bash wrappers and return JS entry point (for Node interceptor)
function getClaudeAbsolutePath(customPath) {
    const claudePath = findClaudePath(customPath);
    const isWindows = process.platform === "win32";
    // Check if the path is a bash wrapper (Unix only)
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

// Get raw binary path (for native binary detection)
function getClaudeBinaryPath(customPath) {
    const claudePath = findClaudePath(customPath);
    const isWindows = process.platform === "win32";
    // On Windows, resolve .cmd wrapper to the actual binary
    if (isWindows && fs.existsSync(claudePath)) {
        const content = fs.readFileSync(claudePath, "utf-8");
        // npm .cmd wrapper: extract the path to the actual exe
        const cmdMatch = content.match(/"?%dp0%\\([^"]+\.exe)"?\s/i);
        if (cmdMatch && cmdMatch[1]) {
            const dir = path.dirname(claudePath);
            const resolved = path.join(dir, cmdMatch[1]);
            if (fs.existsSync(resolved)) {
                return resolved;
            }
        }
        // bash shell wrapper: extract exec target
        const shMatch = content.match(/exec\s+"?\$basedir\/([^"]+\.exe)"?\s/);
        if (shMatch && shMatch[1]) {
            const dir = path.dirname(claudePath);
            const resolved = path.join(dir, shMatch[1]);
            if (fs.existsSync(resolved)) {
                return resolved;
            }
        }
        // If it's already an .exe, just resolve symlinks
        if (claudePath.endsWith(".exe")) {
            try { return fs.realpathSync(claudePath); } catch { return claudePath; }
        }
        // Try to find .exe next to it or in known locations
        const exePath = claudePath + ".exe";
        if (fs.existsSync(exePath)) {
            return exePath;
        }
        // Try the npm node_modules path directly
        const dir = path.dirname(claudePath);
        const npmExePath = path.join(dir, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
        if (fs.existsSync(npmExePath)) {
            return npmExePath;
        }
    }
    // On Unix, resolve bash wrappers to find the actual binary
    if (!isWindows && fs.existsSync(claudePath)) {
        const content = fs.readFileSync(claudePath, "utf-8");
        if (content.startsWith("#!/bin/bash") || content.startsWith("#!/bin/sh")) {
            const execMatch = content.match(/exec\s+"([^"]+)"/);
            if (execMatch && execMatch[1]) {
                try { return fs.realpathSync(execMatch[1]); } catch { return execMatch[1]; }
            }
        }
    }
    try { return fs.realpathSync(claudePath); } catch { return claudePath; }
}

function getLoaderPath() {
    const loaderPath = path.join(__dirname, "interceptor-loader.js");
    if (!fs.existsSync(loaderPath)) {
        log(`Interceptor loader not found at: ${loaderPath}`, "red");
        process.exit(1);
    }
    return loaderPath;
}

// Magic bytes for detecting native binaries
const NATIVE_BINARY_SIGNATURES = {
    ELF: Buffer.from([0x7f, 0x45, 0x4c, 0x46]),
    MACHO_32: Buffer.from([0xfe, 0xed, 0xfa, 0xce]),
    MACHO_64: Buffer.from([0xfe, 0xed, 0xfa, 0xcf]),
    MACHO_32_REV: Buffer.from([0xce, 0xfa, 0xed, 0xfe]),
    MACHO_64_REV: Buffer.from([0xcf, 0xfa, 0xed, 0xfe]),
    MACHO_FAT: Buffer.from([0xca, 0xfe, 0xba, 0xbe]),
    PE: Buffer.from([0x4d, 0x5a]),
};

function isNativeBinary(filePath) {
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

function getClaudeConfigDir() {
    return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
}

function readUpstreamBaseUrl() {
    const settingsPath = path.join(getClaudeConfigDir(), "settings.json");
    if (fs.existsSync(settingsPath)) {
        try {
            const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
            if (settings.env?.ANTHROPIC_BASE_URL) {
                return settings.env.ANTHROPIC_BASE_URL;
            }
        }
        catch {
            // Fall through to environment/default
        }
    }
    return process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com";
}

// Use a temp config dir so settings.json env does not override the local proxy URL.
// The original ~/.claude/settings.json is read-only and never modified.
function prepareClaudeSpawnEnv(proxyUrl) {
    const settingsPath = path.join(getClaudeConfigDir(), "settings.json");
    let tmpDir = null;
    const spawnEnv = {
        ...process.env,
        ANTHROPIC_BASE_URL: proxyUrl,
    };
    if (fs.existsSync(settingsPath)) {
        try {
            const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
            if (settings.env?.ANTHROPIC_BASE_URL) {
                tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-trace-"));
                const { ANTHROPIC_BASE_URL, ...restEnv } = settings.env;
                settings.env = restEnv;
                fs.writeFileSync(path.join(tmpDir, "settings.json"), JSON.stringify(settings, null, 2));
                spawnEnv.CLAUDE_CONFIG_DIR = tmpDir;
            }
        }
        catch (error) {
            const err = error;
            log(`Warning: could not prepare temp Claude config: ${err.message}`, "yellow");
        }
    }
    return { tmpDir, spawnEnv };
}

function cleanupTempClaudeConfig(tmpDir) {
    if (!tmpDir) {
        return;
    }
    try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
    catch {
        // Best-effort cleanup
    }
}

// Run Claude as a native binary with reverse proxy interception
async function runClaudeNativeWithProxy(claudePath, claudeArgs = [], includeAllRequests = false, openInBrowser = false, logBaseName, logSensitiveHeaders = false) {
    log("Using reverse proxy mode for native binary", "yellow");
    const upstreamBaseUrl = readUpstreamBaseUrl();
    log(`Upstream API: ${upstreamBaseUrl}`, "blue");
    console.log("");
    const proxy = new reverse_proxy_1.ReverseProxyServer({
        logBaseName: logBaseName,
        includeAllRequests: includeAllRequests,
        openBrowser: openInBrowser,
        logSensitiveHeaders: logSensitiveHeaders,
        targetBaseUrl: upstreamBaseUrl,
    });
    let proxyInfo;
    let tmpConfigDir = null;
    const shutdown = () => {
        proxy.stop();
        cleanupTempClaudeConfig(tmpConfigDir);
    };
    try {
        proxyInfo = await proxy.start();
        log(`Reverse proxy started at ${proxyInfo.url}`, "green");
        console.log("");
    }
    catch (error) {
        const err = error;
        log(`Failed to start reverse proxy: ${err.message}`, "red");
        process.exit(1);
    }
    const { tmpDir, spawnEnv } = prepareClaudeSpawnEnv(proxyInfo.url);
    tmpConfigDir = tmpDir;
    if (tmpConfigDir) {
        log("Using temporary Claude config (original settings.json unchanged)", "blue");
    }
    const child = (0, child_process_1.spawn)(claudePath, claudeArgs, {
        env: spawnEnv,
        stdio: "inherit",
        cwd: process.cwd(),
    });
    child.on("error", (error) => {
        shutdown();
        log(`Error starting Claude: ${error.message}`, "red");
        process.exit(1);
    });
    child.on("exit", (code, signal) => {
        shutdown();
        if (signal) {
            log(`\nClaude terminated by signal: ${signal}`, "yellow");
        }
        else if (code !== 0 && code !== null) {
            log(`\nClaude exited with code: ${code}`, "yellow");
        }
        else {
            log("\nClaude session completed", "green");
        }
    });
    const handleSignal = (signal) => {
        log(`\nReceived ${signal}, shutting down...`, "yellow");
        shutdown();
        if (child.pid) {
            child.kill(signal);
        }
    };
    process.on("SIGINT", () => handleSignal("SIGINT"));
    process.on("SIGTERM", () => handleSignal("SIGTERM"));
    try {
        await new Promise((resolve, reject) => {
            child.on("exit", () => resolve());
            child.on("error", reject);
        });
    }
    catch (error) {
        const err = error;
        shutdown();
        log(`Unexpected error: ${err.message}`, "red");
        process.exit(1);
    }
}

// Scenario 1: No args -> launch node with interceptor and absolute path to claude
async function runClaudeWithInterception(claudeArgs = [], includeAllRequests = false, openInBrowser = false, customClaudePath, logBaseName, logSensitiveHeaders = false) {
    log("Claude Trace", "blue");
    log("Starting Claude with traffic logging", "yellow");
    if (claudeArgs.length > 0) {
        log(`Claude arguments: ${claudeArgs.join(" ")}`, "blue");
    }
    console.log("");
    // Get the binary path and check if it's a native binary
    const claudePath = getClaudeBinaryPath(customClaudePath);
    log(`Using Claude binary: ${claudePath}`, "blue");
    // Check if this is a native binary (ELF, Mach-O, PE)
    if (isNativeBinary(claudePath)) {
        log("Detected native binary", "yellow");
        await runClaudeNativeWithProxy(claudePath, claudeArgs, includeAllRequests, openInBrowser, logBaseName, logSensitiveHeaders);
        return;
    }
    // For Node.js-based Claude, use the original interceptor approach
    const jsPath = resolveToJsFile(claudePath);
    const loaderPath = getLoaderPath();
    log(`Using JavaScript entry: ${jsPath}`, "blue");
    log("Starting traffic logger...", "green");
    console.log("");
    const spawnArgs = ["--require", loaderPath, jsPath, ...claudeArgs];
    const child = (0, child_process_1.spawn)("node", spawnArgs, {
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
    child.on("error", (error) => {
        log(`Error starting Claude: ${error.message}`, "red");
        process.exit(1);
    });
    child.on("exit", (code, signal) => {
        if (signal) {
            log(`\nClaude terminated by signal: ${signal}`, "yellow");
        }
        else if (code !== 0 && code !== null) {
            log(`\nClaude exited with code: ${code}`, "yellow");
        }
        else {
            log("\nClaude session completed", "green");
        }
    });
    const handleSignal = (signal) => {
        log(`\nReceived ${signal}, shutting down...`, "yellow");
        if (child.pid) {
            child.kill(signal);
        }
    };
    process.on("SIGINT", () => handleSignal("SIGINT"));
    process.on("SIGTERM", () => handleSignal("SIGTERM"));
    try {
        await new Promise((resolve, reject) => {
            child.on("exit", () => resolve());
            child.on("error", reject);
        });
    }
    catch (error) {
        const err = error;
        log(`Unexpected error: ${err.message}`, "red");
        process.exit(1);
    }
}
// Scenario 2: --extract-token -> launch node with token interceptor and absolute path to claude
async function extractToken(customClaudePath) {
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
    const cleanup = () => {
        try {
            if (fs.existsSync(tokenFile))
                fs.unlinkSync(tokenFile);
        }
        catch (e) {
            // Ignore cleanup errors
        }
    };
    const { ANTHROPIC_API_KEY, ...envWithoutApiKey } = process.env;
    const child = (0, child_process_1.spawn)("node", ["--require", tokenExtractorPath, claudePath, "-p", "hello"], {
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
    child.on("error", (error) => {
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
        }
        catch (e) {
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
        }
        catch (e) {
            // Ignore read errors, keep trying
        }
    }, 500);
}
// Scenario 3: --generate-html input.jsonl output.html
async function generateHTMLFromCLI(inputFile, outputFile, includeAllRequests = false, openInBrowser = false) {
    try {
        const htmlGenerator = new html_generator_1.HTMLGenerator();
        const finalOutputFile = await htmlGenerator.generateHTMLFromJSONL(inputFile, outputFile, includeAllRequests);
        if (openInBrowser) {
            if (process.platform === "win32") {
                (0, child_process_1.spawn)("cmd", ["/c", "start", "", finalOutputFile], { detached: true, stdio: "ignore" }).unref();
            } else {
                (0, child_process_1.spawn)("open", [finalOutputFile], { detached: true, stdio: "ignore" }).unref();
            }
            log(`Opening ${finalOutputFile} in browser`, "green");
        }
        process.exit(0);
    }
    catch (error) {
        const err = error;
        log(`Error: ${err.message}`, "red");
        process.exit(1);
    }
}
// Scenario 4: --index
async function generateIndex() {
    try {
        const { IndexGenerator } = await Promise.resolve().then(() => __importStar(require("./index-generator")));
        const indexGenerator = new IndexGenerator();
        await indexGenerator.generateIndex();
        process.exit(0);
    }
    catch (error) {
        const err = error;
        log(`Error: ${err.message}`, "red");
        process.exit(1);
    }
}
// Main entry point
async function main() {
    const args = process.argv.slice(2);
    const argIndex = args.indexOf("--run-with");
    let claudeTraceArgs;
    let claudeArgs;
    if (argIndex !== -1) {
        claudeTraceArgs = args.slice(0, argIndex);
        claudeArgs = args.slice(argIndex + 1);
    }
    else {
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
    let customClaudePath;
    const claudePathIndex = claudeTraceArgs.indexOf("--claude-path");
    if (claudePathIndex !== -1 && claudeTraceArgs[claudePathIndex + 1]) {
        customClaudePath = claudeTraceArgs[claudePathIndex + 1];
    }
    let logBaseName;
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
        let outputFile;
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
    await runClaudeWithInterception(claudeArgs, includeAllRequests, openInBrowser, customClaudePath, logBaseName, logSensitiveHeaders);
}
main().catch((error) => {
    const err = error;
    log(`Unexpected error: ${err.message}`, "red");
    process.exit(1);
});