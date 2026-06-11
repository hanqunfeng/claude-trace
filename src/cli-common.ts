/**
 * @file cli-common.ts
 * @description Shared CLI utilities used by claude-trace, opencode-trace, and codex-trace.
 *
 * Provides colored console output, argument parsing, HTML generation from logs,
 * conversation index generation, and debug/error logging helpers for the reverse proxy.
 */

import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { HTMLGenerator } from "./html-generator";

/** ANSI escape codes for terminal-colored log output. */
export const colors = {
	red: "\x1b[0;31m",
	green: "\x1b[0;32m",
	yellow: "\x1b[1;33m",
	blue: "\x1b[0;34m",
	reset: "\x1b[0m",
} as const;

type ColorName = keyof typeof colors;

/**
 * Print a colored message to stdout.
 * @param message - Text to print
 * @param color - Color key from `colors` (default: no color)
 */
export function log(message: string, color: ColorName = "reset"): void {
	console.log(`${colors[color]}${message}${colors.reset}`);
}

/** @returns true when OPENCODE_TRACE_DEBUG=1 or "true" (enables verbose proxy stderr). */
export function isTraceDebugEnabled(): boolean {
	const value = process.env.OPENCODE_TRACE_DEBUG;
	return value === "1" || value === "true";
}

/** Write to stderr only when OPENCODE_TRACE_DEBUG is set — avoids polluting OpenCode TUI. */
export function traceDebug(message: string): void {
	if (isTraceDebugEnabled()) {
		console.error(message);
	}
}

/**
 * Persist runtime proxy errors to log dir; stderr only in debug mode.
 * @param message - Error description with context
 * @param logDirectory - Tool log dir (e.g. ".opencode-trace") for proxy-errors.log
 */
export function traceRuntimeError(message: string, logDirectory?: string): void {
	const line = `[${new Date().toISOString()}] ${message}\n`;
	if (logDirectory) {
		try {
			fs.appendFileSync(path.join(logDirectory, "proxy-errors.log"), line);
		} catch {
			// ignore file write failures
		}
	}
	traceDebug(message);
}

/** Result of splitting argv into trace flags vs tool passthrough args. */
export interface ParsedTraceArgs {
	/** Flags consumed by claude-trace / opencode-trace / codex-trace. */
	traceArgs: string[];
	/** Arguments after `--run-with` forwarded to the underlying tool. */
	toolArgs: string[];
	includeAllRequests: boolean;
	openInBrowser: boolean;
	logSensitiveHeaders: boolean;
	logBaseName?: string;
}

/**
 * Parse shared CLI flags from process.argv slice.
 * Everything after `--run-with` is treated as tool arguments.
 * @param args - Typically process.argv.slice(2)
 */
export function parseTraceArgs(args: string[]): ParsedTraceArgs {
	const argIndex = args.indexOf("--run-with");
	const traceArgs = argIndex !== -1 ? args.slice(0, argIndex) : args;
	const toolArgs = argIndex !== -1 ? args.slice(argIndex + 1) : [];

	const logIndex = traceArgs.indexOf("--log");
	let logBaseName: string | undefined;
	if (logIndex !== -1 && traceArgs[logIndex + 1]) {
		logBaseName = traceArgs[logIndex + 1];
	}

	return {
		traceArgs,
		toolArgs,
		includeAllRequests: traceArgs.includes("--include-all-requests"),
		openInBrowser: !traceArgs.includes("--no-open"),
		logSensitiveHeaders: traceArgs.includes("--include-sensitive-headers"),
		logBaseName,
	};
}

/**
 * Extract input/output paths following the `--generate-html` flag.
 * @param traceArgs - Parsed trace-side arguments only
 */
export function parseGenerateHtmlArgs(traceArgs: string[]): { inputFile?: string; outputFile?: string } {
	const flagIndex = traceArgs.indexOf("--generate-html");
	if (flagIndex === -1) {
		return {};
	}

	const inputFile = traceArgs[flagIndex + 1];
	let outputFile: string | undefined;
	for (let i = flagIndex + 2; i < traceArgs.length; i++) {
		const arg = traceArgs[i];
		if (!arg.startsWith("--")) {
			outputFile = arg;
			break;
		}
	}

	return { inputFile, outputFile };
}

/**
 * CLI handler for `--generate-html`: build self-contained HTML from JSONL and optionally open it.
 * @param inputFile - Path to .jsonl or .json log file
 * @param outputFile - Optional output .html path
 * @param includeAllRequests - Pass through to HTMLGenerator filtering
 * @param openInBrowser - Launch default browser after generation
 * @param tool - Tool name for report metadata
 */
export async function generateHTMLFromCLI(
	inputFile: string,
	outputFile?: string,
	includeAllRequests: boolean = false,
	openInBrowser: boolean = false,
	tool?: string,
): Promise<void> {
	try {
		const htmlGenerator = new HTMLGenerator();
		const finalOutputFile = await htmlGenerator.generateHTMLFromJSONL(
			inputFile,
			outputFile,
			includeAllRequests,
			tool,
		);

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

/**
 * CLI handler for `--index`: scan log directory and write conversation summaries.
 * @param traceDir - e.g. ".claude-trace"
 */
export async function generateIndex(traceDir: string): Promise<void> {
	try {
		const { IndexGenerator } = await import("./index-generator");
		const indexGenerator = new IndexGenerator(traceDir);
		await indexGenerator.generateIndex();
		process.exit(0);
	} catch (error) {
		const err = error as Error;
		log(`Error: ${err.message}`, "red");
		process.exit(1);
	}
}
