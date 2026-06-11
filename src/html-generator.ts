/**
 * @file Self-contained HTML report generator.
 *
 * Reads the frontend template and bundled IIFE, injects base64-encoded trace
 * data and metadata, and writes a single HTML file that opens offline in any
 * browser without a server.
 */

import fs from "fs";
import path from "path";
import { RawPair, ClaudeData, HTMLGenerationData } from "./types";

/**
 * Builds self-contained HTML trace reports from raw API request/response pairs.
 *
 * The output file embeds the compiled frontend bundle plus session data so the
 * viewer works without network access or a local dev server.
 */
export class HTMLGenerator {
	private frontendDir: string;
	private templatePath: string;
	private bundlePath: string;

	/**
	 * Resolves paths to `frontend/template.html` and `frontend/dist/index.global.js`
	 * relative to the compiled `dist/` output directory.
	 */
	constructor() {
		this.frontendDir = path.join(__dirname, "..", "frontend");
		this.templatePath = path.join(this.frontendDir, "template.html");
		this.bundlePath = path.join(this.frontendDir, "dist", "index.global.js");
	}

	/**
	 * Verifies the frontend bundle exists before attempting template assembly.
	 * @throws When `frontend/dist/index.global.js` has not been built.
	 */
	private ensureFrontendBuilt(): void {
		if (!fs.existsSync(this.bundlePath)) {
			throw new Error(
				`Frontend bundle not found at ${this.bundlePath}. ` + `Run 'npm run build' in frontend directory first.`,
			);
		}
	}

	/**
	 * Loads the HTML shell and the compiled Lit viewer bundle from disk.
	 * @returns Template HTML string and the minified IIFE bundle contents.
	 */
	private loadTemplateFiles(): { htmlTemplate: string; jsBundle: string } {
		this.ensureFrontendBuilt();

		const htmlTemplate = fs.readFileSync(this.templatePath, "utf-8");
		const jsBundle = fs.readFileSync(this.bundlePath, "utf-8");

		return { htmlTemplate, jsBundle };
	}

	/**
	 * Keeps only Anthropic Messages API and Bedrock runtime calls.
	 * Currently unused — filtering was removed to avoid dropping valid data.
	 *
	 * @param pairs - Raw logged pairs to filter.
	 * @returns Pairs whose request URL targets `/v1/messages` or Bedrock runtime.
	 */
	private filterClaudeAPIPairs(pairs: RawPair[]): RawPair[] {
		return pairs.filter((pair) => {
			const url = pair.request.url;
			// Include both Anthropic API and Bedrock API calls
			return url.includes("/v1/messages") || url.includes("bedrock-runtime.amazonaws.com");
		});
	}

	/**
	 * Drops pairs whose request has two or fewer messages (likely heartbeats).
	 * Currently unused — kept for reference.
	 *
	 * @param pairs - Raw logged pairs to filter.
	 * @returns Pairs with more than two request messages, or non-array message lists.
	 */
	private filterShortConversations(pairs: RawPair[]): RawPair[] {
		return pairs.filter((pair) => {
			const messages = pair.request?.body?.messages;
			if (!Array.isArray(messages)) return true;
			return messages.length > 2;
		});
	}

	/**
	 * Serializes trace data to base64 so it can be safely embedded in HTML
	 * without escaping issues in inline script tags.
	 *
	 * @param data - Session pairs, timestamp, and viewer metadata.
	 * @returns Base64-encoded JSON assigned to `window.claudeData` at runtime.
	 */
	private prepareDataForInjection(data: HTMLGenerationData): string {
		const claudeData: ClaudeData = {
			rawPairs: data.rawPairs,
			timestamp: data.timestamp,
			metadata: {
				includeAllRequests: data.includeAllRequests || false,
				...(data.tool ? { tool: data.tool } : {}),
			},
		};

		// Compact JSON keeps the embedded payload smaller
		const dataJson = JSON.stringify(claudeData, null, 0);

		// Base64 avoids `</script>` and quote-escaping problems in inline HTML
		return Buffer.from(dataJson, "utf-8").toString("base64");
	}

	/**
	 * Escapes user-controlled strings before inserting them into HTML attributes
	 * or text nodes (e.g. the report `<title>`).
	 */
	private escapeHtml(text: string): string {
		return text
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;")
			.replace(/'/g, "&#39;");
	}

	/** Maps tool profile id to the display brand shown in the report title. */
	private buildReportBrand(tool?: string): string {
		if (tool === "claude") return "claude-trace";
		if (tool === "opencode") return "opencode-trace";
		if (tool === "codex") return "codex-trace";
		return "trace";
	}

	/** Builds the default `<title>` text, e.g. `claude-trace · 42 API Calls`. */
	private buildReportTitle(pairCount: number, tool?: string): string {
		return `${this.buildReportBrand(tool)} · ${pairCount} API Calls`;
	}

	/**
	 * Writes a self-contained HTML report for the given raw pairs.
	 *
	 * @param pairs - All logged request/response pairs for the session.
	 * @param outputFile - Destination `.html` path.
	 * @param options - Optional title, timestamp, filter flag, and tool id.
	 */
	public async generateHTML(
		pairs: RawPair[],
		outputFile: string,
		options: {
			title?: string;
			timestamp?: string;
			includeAllRequests?: boolean;
			tool?: string;
		} = {},
	): Promise<void> {
		try {
			let filteredPairs = pairs;

			// Remove filtering entirely - show all data
			// Previously filtered to only include v1/messages pairs with messages.length >= 2
			// but this was too aggressive and excluded valid data

			// Load template and bundle files
			const { htmlTemplate, jsBundle } = this.loadTemplateFiles();

			// Prepare data for injection
			const htmlData: HTMLGenerationData = {
				rawPairs: filteredPairs,
				timestamp: options.timestamp || new Date().toISOString().replace("T", " ").slice(0, -5),
				includeAllRequests: options.includeAllRequests || false,
				tool: options.tool,
			};

			const dataJsonEscaped = this.prepareDataForInjection(htmlData);

			// BIZARRE BUT NECESSARY: Use split() instead of replace() for bundle injection
			//
			// Why this weird approach? Using replace instead of split() for some reason duplicates
			// the htmlTemplate itself inside the new string! Maybe a bug in Node's String.replace?
			const templateParts = htmlTemplate.split("__CLAUDE_LOGGER_BUNDLE_REPLACEMENT_UNIQUE_9487__");
			if (templateParts.length !== 2) {
				throw new Error("Template bundle replacement marker not found or found multiple times");
			}

			// Reconstruct the template with the bundle injected between the split parts
			let htmlContent = templateParts[0] + jsBundle + templateParts[1];
			htmlContent = htmlContent
				.replace("__CLAUDE_LOGGER_DATA_REPLACEMENT_UNIQUE_9487__", dataJsonEscaped)
				.replace(
					"__CLAUDE_LOGGER_TITLE_REPLACEMENT_UNIQUE_9487__",
					this.escapeHtml(
						options.title || this.buildReportTitle(filteredPairs.length, options.tool),
					),
				);

			// Ensure output directory exists
			const outputDir = path.dirname(outputFile);
			if (!fs.existsSync(outputDir)) {
				fs.mkdirSync(outputDir, { recursive: true });
			}

			// Write HTML file
			fs.writeFileSync(outputFile, htmlContent, "utf-8");
		} catch (error) {
			console.error(`Error generating HTML: ${error}`);
			throw error;
		}
	}

	/**
	 * Reads a JSONL log file and generates the corresponding HTML report.
	 *
	 * @param jsonlFile - Path to a session `.jsonl` log.
	 * @param outputFile - Optional output path; defaults to same name with `.html`.
	 * @param includeAllRequests - Passed through to viewer metadata.
	 * @param tool - Tool profile id for branding in the report title.
	 * @returns The path of the written HTML file.
	 */
	public async generateHTMLFromJSONL(
		jsonlFile: string,
		outputFile?: string,
		includeAllRequests: boolean = true,
		tool?: string,
	): Promise<string> {
		if (!fs.existsSync(jsonlFile)) {
			throw new Error(`File '${jsonlFile}' not found.`);
		}

		// Load all pairs from the JSONL file
		const pairs: RawPair[] = [];
		const fileContent = fs.readFileSync(jsonlFile, "utf-8");
		const lines = fileContent.split("\n");

		for (let lineNum = 0; lineNum < lines.length; lineNum++) {
			const line = lines[lineNum].trim();
			if (line) {
				try {
					const pair = JSON.parse(line) as RawPair;
					pairs.push(pair);
				} catch (error) {
					console.warn(`Warning: Skipping invalid JSON on line ${lineNum + 1}: ${line.slice(0, 100)}...`);
					continue;
				}
			}
		}

		if (pairs.length === 0) {
			throw new Error(`No valid data found in '${jsonlFile}'.`);
		}

		// Determine output file
		if (!outputFile) {
			outputFile = jsonlFile.replace(/\.jsonl$/, ".html");
		}

		await this.generateHTML(pairs, outputFile, { includeAllRequests, tool });
		return outputFile;
	}

	/** Returns resolved paths to the template and bundle for diagnostics. */
	public getTemplatePaths(): { templatePath: string; bundlePath: string } {
		return {
			templatePath: this.templatePath,
			bundlePath: this.bundlePath,
		};
	}
}
