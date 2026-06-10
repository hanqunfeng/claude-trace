#!/usr/bin/env node

import { codexProfile } from "./tools/codex";
import { runWithTracing } from "./trace-runner";
import {
	colors,
	log,
	parseTraceArgs,
	parseGenerateHtmlArgs,
	generateHTMLFromCLI,
	generateIndex,
} from "./cli-common";

function showHelp(): void {
	console.log(`
${colors.blue}Codex Trace${colors.reset}
Record all your interactions with Codex CLI as you develop your projects

${colors.yellow}USAGE:${colors.reset}
  codex-trace [OPTIONS] [--run-with CODEX_ARG...]

${colors.yellow}OPTIONS:${colors.reset}
  --generate-html    Generate HTML report from JSONL file
  --index           Generate conversation summaries and index for .codex-trace/ directory
  --run-with         Pass all following arguments to Codex process
  --include-all-requests Include all proxied API traffic, not just LLM API paths
  --include-sensitive-headers Log sensitive headers (auth tokens, cookies) without redaction
  --no-open          Don't open generated HTML file in browser
  --log              Specify custom log file base name (without extension)
  --codex-path       Specify custom path to Codex binary
  --help, -h         Show this help message

${colors.yellow}MODES:${colors.reset}
  ${colors.green}Interactive logging:${colors.reset}
    codex-trace                               Start Codex TUI with traffic logging
    codex-trace --log my-session              Start Codex with custom log file name
    codex-trace --run-with exec "Explain closures"  Run Codex headless with a prompt

  ${colors.green}HTML generation:${colors.reset}
    codex-trace --generate-html file.jsonl          Generate HTML from JSONL file
    codex-trace --generate-html file.jsonl out.html Generate HTML with custom output name

  ${colors.green}Indexing:${colors.reset}
    codex-trace --index                             Generate conversation summaries and index

${colors.yellow}EXAMPLES:${colors.reset}
  # Start Codex TUI with logging
  codex-trace

  # Run a one-shot prompt with logging
  codex-trace --run-with exec "Explain async/await"

  # Generate HTML report
  codex-trace --generate-html .codex-trace/log-2025-01-01-12-00-00.jsonl

  # Use custom Codex binary path
  codex-trace --codex-path /usr/local/bin/codex

${colors.yellow}CONFIG:${colors.reset}
  Codex config is read from (in order):
    1. CODEX_HOME environment variable
    2. ~/.codex/config.toml

  Intercepts OpenAI API Key, ChatGPT OAuth, and custom model_providers via
  CODEX_HOME config overlay. Your original config file is never modified.

${colors.yellow}OUTPUT:${colors.reset}
  Logs are saved to: ${colors.green}.codex-trace/log-YYYY-MM-DD-HH-MM-SS.{jsonl,html}${colors.reset}
  With --log NAME:   ${colors.green}.codex-trace/NAME.{jsonl,html}${colors.reset}

For more information, visit: https://github.com/hanqunfeng/claude-trace
`);
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const { traceArgs, toolArgs, includeAllRequests, openInBrowser, logSensitiveHeaders, logBaseName } =
		parseTraceArgs(args);

	if (traceArgs.includes("--help") || traceArgs.includes("-h")) {
		showHelp();
		process.exit(0);
	}

	let customCodexPath: string | undefined;
	const codexPathIndex = traceArgs.indexOf("--codex-path");
	if (codexPathIndex !== -1 && traceArgs[codexPathIndex + 1]) {
		customCodexPath = traceArgs[codexPathIndex + 1];
	}

	if (traceArgs.includes("--generate-html")) {
		const { inputFile, outputFile } = parseGenerateHtmlArgs(traceArgs);

		if (!inputFile) {
			log(`Missing input file for --generate-html`, "red");
			log(`Usage: codex-trace --generate-html input.jsonl [output.html]`, "yellow");
			process.exit(1);
		}

		await generateHTMLFromCLI(inputFile, outputFile, includeAllRequests, openInBrowser, "codex");
		return;
	}

	if (traceArgs.includes("--index")) {
		await generateIndex(codexProfile.logDirectory);
		return;
	}

	await runWithTracing(codexProfile, toolArgs, {
		includeAllRequests,
		openInBrowser,
		logBaseName,
		logSensitiveHeaders,
		customBinaryPath: customCodexPath,
	});
}

main().catch((error) => {
	const err = error as Error;
	log(`Unexpected error: ${err.message}`, "red");
	process.exit(1);
});
