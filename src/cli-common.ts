import { spawn } from "child_process";
import { HTMLGenerator } from "./html-generator";

export const colors = {
	red: "\x1b[0;31m",
	green: "\x1b[0;32m",
	yellow: "\x1b[1;33m",
	blue: "\x1b[0;34m",
	reset: "\x1b[0m",
} as const;

type ColorName = keyof typeof colors;

export function log(message: string, color: ColorName = "reset"): void {
	console.log(`${colors[color]}${message}${colors.reset}`);
}

export interface ParsedTraceArgs {
	traceArgs: string[];
	toolArgs: string[];
	includeAllRequests: boolean;
	openInBrowser: boolean;
	logSensitiveHeaders: boolean;
	logBaseName?: string;
}

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
