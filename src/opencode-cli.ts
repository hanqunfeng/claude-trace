#!/usr/bin/env node

import { opencodeProfile } from "./tools/opencode";
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
${colors.blue}OpenCode Trace${colors.reset}
Record all your interactions with OpenCode as you develop your projects

${colors.yellow}USAGE:${colors.reset}
  opencode-trace [OPTIONS] [--run-with OPENCODE_ARG...]

${colors.yellow}OPTIONS:${colors.reset}
  --generate-html    Generate HTML report from JSONL file
  --index           Generate conversation summaries and index for .opencode-trace/ directory
  --run-with         Pass all following arguments to OpenCode process
  --include-all-requests Include all proxied API traffic, not just /v1/messages
  --include-sensitive-headers Log sensitive headers (auth tokens, cookies) without redaction
  --no-open          Don't open generated HTML file in browser
  --log              Specify custom log file base name (without extension)
  --opencode-path    Specify custom path to OpenCode binary
  --help, -h         Show this help message

${colors.yellow}MODES:${colors.reset}
  ${colors.green}Interactive logging:${colors.reset}
    opencode-trace                               Start OpenCode with traffic logging
    opencode-trace --log my-session              Start OpenCode with custom log file name
    opencode-trace --run-with run "Explain closures"  Run OpenCode with specific command

  ${colors.green}HTML generation:${colors.reset}
    opencode-trace --generate-html file.jsonl          Generate HTML from JSONL file
    opencode-trace --generate-html file.jsonl out.html Generate HTML with custom output name

  ${colors.green}Indexing:${colors.reset}
    opencode-trace --index                             Generate conversation summaries and index

${colors.yellow}EXAMPLES:${colors.reset}
  # Start OpenCode TUI with logging
  opencode-trace

  # Start with custom log file name
  opencode-trace --log my-session

  # Run a one-shot prompt with logging
  opencode-trace --run-with run "Explain async/await"

  # Run with a specific model
  opencode-trace --run-with run -m anthropic/claude-sonnet-4 "Refactor this module"

  # Generate HTML report
  opencode-trace --generate-html .opencode-trace/log-2025-01-01-12-00-00.jsonl

  # Generate conversation index
  opencode-trace --index

  # Use custom OpenCode binary path
  opencode-trace --opencode-path /usr/local/bin/opencode

${colors.yellow}CONFIG:${colors.reset}
  OpenCode config is read from (in order):
    1. OPENCODE_CONFIG environment variable
    2. OPENCODE_CONFIG_DIR/opencode.json
    3. ~/.config/opencode/opencode.json
    4. .opencode/opencode.json in current directory

  Phase 1 intercepts the Anthropic provider via provider.anthropic.options.baseURL.
  Your original config file is never modified — a temporary config is used at runtime.

${colors.yellow}OUTPUT:${colors.reset}
  Logs are saved to: ${colors.green}.opencode-trace/log-YYYY-MM-DD-HH-MM-SS.{jsonl,html}${colors.reset}
  With --log NAME:   ${colors.green}.opencode-trace/NAME.{jsonl,html}${colors.reset}

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

	let customOpenCodePath: string | undefined;
	const opencodePathIndex = traceArgs.indexOf("--opencode-path");
	if (opencodePathIndex !== -1 && traceArgs[opencodePathIndex + 1]) {
		customOpenCodePath = traceArgs[opencodePathIndex + 1];
	}

	if (traceArgs.includes("--generate-html")) {
		const { inputFile, outputFile } = parseGenerateHtmlArgs(traceArgs);

		if (!inputFile) {
			log(`Missing input file for --generate-html`, "red");
			log(`Usage: opencode-trace --generate-html input.jsonl [output.html]`, "yellow");
			process.exit(1);
		}

		await generateHTMLFromCLI(inputFile, outputFile, includeAllRequests, openInBrowser, "opencode");
		return;
	}

	if (traceArgs.includes("--index")) {
		await generateIndex(opencodeProfile.logDirectory);
		return;
	}

	await runWithTracing(opencodeProfile, toolArgs, {
		includeAllRequests,
		openInBrowser,
		logBaseName,
		logSensitiveHeaders,
		customBinaryPath: customOpenCodePath,
	});
}

main().catch((error) => {
	const err = error as Error;
	log(`Unexpected error: ${err.message}`, "red");
	process.exit(1);
});
