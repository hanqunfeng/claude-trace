#!/usr/bin/env node

/**
 * @file vibe-coding-proxy-cli.ts
 * @description Entry point for the standalone `vibe-coding-proxy` command.
 *
 * Starts an independent HTTP/HTTPS forward proxy that clients can use through
 * HTTP_PROXY, HTTPS_PROXY, or ALL_PROXY. The command does not spawn Claude Code
 * or any other CLI; it only prints the proxy URL, captures allowlisted model API
 * traffic, and writes JSONL/JSON/HTML reports compatible with the existing UI.
 */

import { colors, generateHTMLFromCLI, log, parseGenerateHtmlArgs } from "./cli-common";
import { ForwardProxyServer, type ForwardProxyConfig } from "../intercept/forward-proxy";

/** Parsed command-line options for `vibe-coding-proxy`. */
interface VibeProxyArgs {
	traceArgs: string[];
	config: ForwardProxyConfig;
}

/**
 * Print a short reference list for common LLM API hosts/paths.
 * This helps users configure `--target-url` / `--mitm-host` without memorizing vendor URLs.
 */
function printCommonApiAddresses(): void {
	console.log("Common API endpoints (examples):");
	console.log("");
	console.log("  Anthropic Messages API:");
	console.log("    host: api.anthropic.com");
	console.log("    path: /v1/messages");
	console.log("    target-url example:");
	console.log("      vibe-coding-proxy --target-url https://api.anthropic.com/v1/messages");
	console.log("");
	console.log("  OpenAI API:");
	console.log("    host: api.openai.com");
	console.log("    paths:");
	console.log("      - /v1/responses");
	console.log("      - /v1/chat/completions");
	console.log("    target-url examples:");
	console.log("      vibe-coding-proxy --target-url https://api.openai.com/v1/responses");
	console.log("      vibe-coding-proxy --target-url https://api.openai.com/v1/chat/completions");
	console.log("");
	console.log("  Codex (ChatGPT OAuth) API:");
	console.log("    host: chatgpt.com");
	console.log("    base: https://chatgpt.com/backend-api/codex");
	console.log("    common path: /backend-api/codex/responses");
	console.log("    target-url examples:");
	console.log("      vibe-coding-proxy --target-url https://chatgpt.com/backend-api/codex");
	console.log("      vibe-coding-proxy --target-url https://chatgpt.com/backend-api/codex/responses");
	console.log("");
	console.log("  Anthropic-compatible gateways (examples):");
	console.log("    - https://api.deepseek.com/anthropic");
	console.log("    - https://api.minimax.chat/anthropic (if enabled by your provider)");
	console.log("");
	console.log("Tip: if you're not sure, start with --mitm-host <host> to decrypt all HTTPS requests for that host.");
}

/** Print command usage and examples. */
function showHelp(): void {
	console.log(`
${colors.blue}vibe-coding-proxy${colors.reset}
Standalone forward proxy for logging allowlisted LLM API traffic

${colors.yellow}USAGE:${colors.reset}
  vibe-coding-proxy --target-url URL [--target-url URL...]

${colors.yellow}OPTIONS:${colors.reset}
  --target-url URL       Full URL prefix to MITM and log (repeatable)
  --mitm-host HOST       Hostname to MITM and log (repeatable)
  --host HOST            Listen host (default: 127.0.0.1)
  --port PORT            Listen port (default: 0, random)
  --log-dir DIR          Log directory (default: .vibe-coding-proxy)
  --log NAME             Log file base name (without extension)
  --ca-dir DIR           Local CA/cache directory
  --no-mitm              Disable TLS MITM; HTTPS CONNECT is pass-through only
  --include-all-requests Log pass-through CONNECT metadata and non-target HTTP traffic
  --include-sensitive-headers Log auth headers without redaction
  --no-open              Do not open generated HTML when the proxy exits
  --generate-html FILE [OUT] Generate HTML from an existing JSONL/JSON log
  --help, -h             Show this help message

${colors.yellow}EXAMPLES:${colors.reset}
  vibe-coding-proxy --target-url https://api.deepseek.com/anthropic
  vibe-coding-proxy --mitm-host api.deepseek.com --port 8888

${colors.yellow}CLIENT SETUP:${colors.reset}
  export HTTP_PROXY=http://127.0.0.1:PORT
  export HTTPS_PROXY=http://127.0.0.1:PORT
  export ALL_PROXY=http://127.0.0.1:PORT
  export NODE_TLS_REJECT_UNAUTHORIZED=0
  export SSL_CERT_FILE=CA_CERT_PATH
`);

	console.log("");
	printCommonApiAddresses();
}

/**
 * Parse repeatable flags and simple scalar options.
 * @param args - Usually `process.argv.slice(2)`.
 */
function parseArgs(args: string[]): VibeProxyArgs {
	const config: ForwardProxyConfig = {
		targetUrls: [],
		mitmHosts: [],
		openBrowser: true,
	};

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		const next = args[i + 1];
		switch (arg) {
			case "--target-url":
				requireValue(arg, next);
				config.targetUrls?.push(next);
				i++;
				break;
			case "--mitm-host":
				requireValue(arg, next);
				config.mitmHosts?.push(next);
				i++;
				break;
			case "--host":
				requireValue(arg, next);
				config.host = next;
				i++;
				break;
			case "--port":
				requireValue(arg, next);
				config.port = Number(next);
				i++;
				break;
			case "--log-dir":
				requireValue(arg, next);
				config.logDirectory = next;
				i++;
				break;
			case "--log":
				requireValue(arg, next);
				config.logBaseName = next;
				i++;
				break;
			case "--ca-dir":
				requireValue(arg, next);
				config.caDir = next;
				i++;
				break;
			case "--no-mitm":
				config.disableMitm = true;
				break;
			case "--include-all-requests":
				config.includeAllRequests = true;
				break;
			case "--include-sensitive-headers":
				config.logSensitiveHeaders = true;
				break;
			case "--no-open":
				config.openBrowser = false;
				break;
		}
	}

	return { traceArgs: args, config };
}

/**
 * Ensure an option with a required argument is followed by a usable value.
 * @param flag - Current option name.
 * @param value - Candidate option value.
 */
function requireValue(flag: string, value: string | undefined): asserts value is string {
	if (!value || value.startsWith("--")) {
		throw new Error(`Missing value for ${flag}`);
	}
}

/** Main CLI dispatcher. */
async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const { traceArgs, config } = parseArgs(args);

	if (traceArgs.includes("--help") || traceArgs.includes("-h")) {
		showHelp();
		process.exit(0);
	}

	if (traceArgs.includes("--generate-html")) {
		const { inputFile, outputFile } = parseGenerateHtmlArgs(traceArgs);
		if (!inputFile) {
			log("Missing input file for --generate-html", "red");
			process.exit(1);
		}
		await generateHTMLFromCLI(inputFile, outputFile, config.includeAllRequests || false, config.openBrowser !== false, "vibe-coding-proxy");
		return;
	}

	const proxy = new ForwardProxyServer(config);
	const info = await proxy.start();
	log(`vibe-coding-proxy started`, "green");
	console.log("");
	console.log(`Proxy URL: ${info.url}`);
	console.log(`Export:`);
	console.log(`  export HTTP_PROXY=${info.url}`);
	console.log(`  export HTTPS_PROXY=${info.url}`);
	console.log(`  export ALL_PROXY=${info.url}`);
	console.log(`  export NODE_TLS_REJECT_UNAUTHORIZED=0`);
	if (info.caCertPath) {
		console.log(`  export SSL_CERT_FILE=${info.caCertPath}`);
		console.log(`CA certificate: ${info.caCertPath}`);
		console.log(`Trust this CA in clients that should expose HTTPS bodies to the proxy.`);
	}
	console.log(`Logs:`);
	console.log(`  JSONL: ${info.logs.jsonl}`);
	console.log(`  JSON:  ${info.logs.json}`);
	console.log(`  HTML:  ${info.logs.html}`);
	console.log("");
	console.log("Press Ctrl+C to stop the proxy.");

	const shutdown = (): void => {
		log("\nStopping vibe-coding-proxy...", "yellow");
		proxy.stop();
		process.exit(0);
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
	await new Promise(() => {
		// Keep the CLI alive until a signal arrives.
	});
}

main().catch((error) => {
	const err = error as Error;
	log(`Error: ${err.message}`, "red");
	process.exit(1);
});
