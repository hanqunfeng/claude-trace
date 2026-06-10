#!/usr/bin/env node

import { claudeProfile, extractClaudeToken } from "./tools/claude";
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

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const { traceArgs, toolArgs, includeAllRequests, openInBrowser, logSensitiveHeaders, logBaseName } =
		parseTraceArgs(args);

	if (traceArgs.includes("--help") || traceArgs.includes("-h")) {
		showHelp();
		process.exit(0);
	}

	let customClaudePath: string | undefined;
	const claudePathIndex = traceArgs.indexOf("--claude-path");
	if (claudePathIndex !== -1 && traceArgs[claudePathIndex + 1]) {
		customClaudePath = traceArgs[claudePathIndex + 1];
	}

	if (traceArgs.includes("--extract-token")) {
		await extractClaudeToken(customClaudePath);
		return;
	}

	if (traceArgs.includes("--generate-html")) {
		const { inputFile, outputFile } = parseGenerateHtmlArgs(traceArgs);

		if (!inputFile) {
			log(`Missing input file for --generate-html`, "red");
			log(`Usage: claude-trace --generate-html input.jsonl [output.html]`, "yellow");
			process.exit(1);
		}

		await generateHTMLFromCLI(inputFile, outputFile, includeAllRequests, openInBrowser, "claude");
		return;
	}

	if (traceArgs.includes("--index")) {
		await generateIndex(claudeProfile.logDirectory);
		return;
	}

	await runWithTracing(claudeProfile, toolArgs, {
		includeAllRequests,
		openInBrowser,
		logBaseName,
		logSensitiveHeaders,
		customBinaryPath: customClaudePath,
	});
}

main().catch((error) => {
	const err = error as Error;
	log(`Unexpected error: ${err.message}`, "red");
	process.exit(1);
});
