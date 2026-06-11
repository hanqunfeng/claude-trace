/**
 * @file Human-readable conversation renderer.
 *
 * Displays merged conversation threads with markdown formatting, tool call
 * previews, diffs, collapsible system prompts, and Codex-specific context tags.
 */

import { LitElement, html, TemplateResult } from "lit";
import { customElement, property } from "lit/decorators.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import * as Diff from "diff";
import type {
	MessageParam,
	TextBlockParam,
	ContentBlock,
	ContentBlockParam,
	Message,
	ToolUnion,
} from "@anthropic-ai/sdk/resources/messages";
import { SimpleConversation, EnhancedMessageParam } from "../../../src/report/shared-conversation-processor";
import { markdownToHtml } from "../utils/markdown";

/** Renders {@link SimpleConversation} threads in the main conversations tab. */
@customElement("simple-conversation-view")
export class SimpleConversationView extends LitElement {
	@property({ type: Array }) conversations: SimpleConversation[] = [];

	/** Light DOM so global Tailwind classes apply. */
	createRenderRoot() {
		return this;
	}

	/**
	 * Generic click handler for collapsible sections.
	 * Supports standard content toggle, Write-tool preview swap, or custom logic.
	 */
	private handleToggle(
		e: Event,
		options: {
			type?: "content" | "write" | "custom";
			targetSelector?: string;
			toggleSelector?: string;
			customHandler?: (element: HTMLElement, isHidden: boolean) => void;
		} = {},
	) {
		const { type = "content", targetSelector, toggleSelector, customHandler } = options;
		const currentElement = e.currentTarget as HTMLElement;

		if (type === "write") {
			const fullContent = currentElement.previousElementSibling as HTMLElement;
			if (fullContent) {
				const isExpanded = !fullContent.classList.contains("hidden");
				if (isExpanded) {
					fullContent.classList.add("hidden");
					currentElement.classList.remove("hidden");
				} else {
					fullContent.classList.remove("hidden");
					currentElement.classList.add("hidden");
				}
			}
			return;
		}

		// Default content toggle behavior
		const target = targetSelector
			? (currentElement.querySelector(targetSelector) as HTMLElement)
			: (currentElement.nextElementSibling as HTMLElement);
		const toggle = toggleSelector
			? (currentElement.querySelector(toggleSelector) as HTMLElement)
			: (currentElement.querySelector("span:first-child") as HTMLElement);

		if (target) {
			const isHidden = target.classList.contains("hidden");

			if (customHandler) {
				customHandler(target, isHidden);
			} else {
				target.classList.toggle("hidden", !isHidden);
				if (toggle) {
					toggle.textContent = isHidden ? "[-]" : "[+]";
				}
			}
		}
	}

	/** Delegates to {@link handleToggle} with default content-toggle behavior. */
	private toggleContent(e: Event) {
		this.handleToggle(e);
	}

	/** Swaps Write-tool preview vs full content panels. */
	private toggleWriteContent(e: Event) {
		this.handleToggle(e, { type: "write" });
	}

	/** Renders an expandable "Thinking" block with markdown formatting. */
	private renderThinkingBlock(thinking: string): TemplateResult {
		const content = thinking.trim();
		if (!content) {
			return html``;
		}

		return this.renderCollapsibleSection(
			"Thinking",
			html`<div class="text-gray-400 markdown-content">${unsafeHTML(markdownToHtml(content))}</div>`,
			{
				titleClasses: "text-gray-500 italic",
				containerClasses: "mt-4 mb-4",
			},
		);
	}

	/**
	 * Renders message content blocks — text, thinking, and tool_use with paired results.
	 *
	 * @param toolResults - Map of tool_use_id → tool_result hoisted by the processor.
	 */
	private formatContent(content: string | ContentBlockParam[], toolResults?: Record<string, any>): TemplateResult {
		if (typeof content === "string") {
			return this.formatStringContent(content);
		}

		if (Array.isArray(content)) {
			return html`
				${content.map((block) => {
					if (block.type === "text") {
						return this.formatStringContent(block.text);
					} else if (block.type === "thinking") {
						const thinkingBlock = block as any;
						return this.renderThinkingBlock(thinkingBlock.thinking || "");
					} else if (block.type === "tool_result") {
						// Skip standalone tool_result blocks - they will be paired with tool_use
						return html``;
					} else if (block.type === "tool_use") {
						const toolUse = block as any;
						const toolResult = toolResults?.[toolUse.id];

						if (block.name === "TodoWrite" || block.name === "Edit" || block.name === "MultiEdit") {
							return this.renderToolContainer(block, toolResult);
						}
						if (block.name === "Write") {
							const customContent = html`
								<div class="bg-vs-bg-secondary p-4 text-vs-text hidden">
									${this.renderToolUseContent(block)}
								</div>
								<div
									class="bg-vs-bg-secondary mx-4 p-4 text-vs-text cursor-pointer hover:bg-vs-border transition-colors"
									@click=${this.toggleWriteContent}
								>
									${this.renderWritePreview(block)}
								</div>
							`;
							return html`
								<div class="mt-4 mb-4">
									<div class="text-vs-type px-4 break-all">${this.getToolDisplayName(block)}</div>
									${customContent} ${toolResult ? this.renderToolResult(toolResult, block) : ""}
								</div>
							`;
						}
						return this.renderToolContainer(block, toolResult, {
							isCollapsible: true,
							isCollapsed: true,
							isClickToExpand: true,
						});
					}
					return html`<pre class="mb-4">${JSON.stringify(block, null, 2)}</pre>`;
				})}
			`;
		}

		return html`<pre>${JSON.stringify(content, null, 2)}</pre>`;
	}

	/**
	 * Finds all occurrences of `<tag>...</tag>` (raw or HTML-escaped) and returns
	 * inner text plus the string with those blocks removed.
	 */
	private extractTaggedBlocks(
		content: string,
		tagName: string,
	): { blocks: string[]; remaining: string } {
		const escapedPattern = new RegExp(`&lt;${tagName}&gt;([\\s\\S]*?)&lt;/${tagName}&gt;`, "g");
		const rawPattern = new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`, "g");
		const blocks: string[] = [];

		for (const regex of [escapedPattern, rawPattern]) {
			let match;
			while ((match = regex.exec(content)) !== null) {
				blocks.push(match[1].trim());
			}
		}

		const remaining = content.replace(escapedPattern, "").replace(rawPattern, "").trim();
		return { blocks, remaining };
	}

	/**
	 * Extract a single outermost tag wrapper. Codex blocks often mention nested
	 * `<tag>...</tag>` examples inside backticks; non-greedy regex stops at the
	 * first inner close tag and leaks the rest into the conversation view.
	 */
	private extractOutermostTaggedBlock(
		content: string,
		tagName: string,
	): { block: string | null; remaining: string } {
		const variants = [
			{ open: `<${tagName}>`, close: `</${tagName}>` },
			{ open: `&lt;${tagName}&gt;`, close: `&lt;/${tagName}&gt;` },
		];

		const trimmed = content.trim();
		for (const { open, close } of variants) {
			if (!trimmed.startsWith(open)) {
				continue;
			}

			const lastClose = trimmed.lastIndexOf(close);
			if (lastClose <= open.length) {
				return { block: null, remaining: content };
			}

			const block = trimmed.slice(open.length, lastClose).trim();
			const after = trimmed.slice(lastClose + close.length).trim();
			const leading = content.slice(0, content.indexOf(trimmed));
			const remaining = (leading + after).trim();
			return { block, remaining };
		}

		return { block: null, remaining: content };
	}

	/** Wraps extracted tag blocks in a numbered collapsible markdown section. */
	private renderTaggedCollapsibleSections(
		title: string,
		blocks: string[],
	): TemplateResult {
		if (blocks.length === 0) {
			return html``;
		}

		return this.renderCollapsibleSection(
			title,
			html`<div class="text-vs-muted">
				${blocks.map(
					(block, index) => html`
						<div class="mb-4">
							${blocks.length > 1
								? html`<div class="text-vs-function font-bold mb-2">${title} ${index + 1}:</div>`
								: ""}
							<div class="markdown-content">${unsafeHTML(markdownToHtml(block))}</div>
						</div>
					`,
				)}
			</div>`,
			{
				titleClasses: "text-vs-muted",
				containerClasses: "mt-4 mb-4",
				count: blocks.length > 1 ? blocks.length : undefined,
			},
		);
	}

	/** Codex injects these XML-like tags in user messages; extracted into collapsible sections. */
	private static readonly CODEX_CONTEXT_TAGS: ReadonlyArray<{ tag: string; title: string }> = [
		{ tag: "permissions instructions", title: "Permissions Instructions" },
		{ tag: "collaboration_mode", title: "Collaboration Mode" },
		{ tag: "skills_instructions", title: "Skills Instructions" },
		{ tag: "environment_context", title: "Environment Context" },
	];

	/** True when the string contains only Codex context tags and no user text. */
	private isCodexContextOnlyText(content: string): boolean {
		const { sections, remaining } = this.extractCodexContextSections(content);
		if (sections.length === 0) {
			return false;
		}

		const { remaining: afterExtremelyImportant } = this.extractTaggedBlocks(remaining, "EXTREMELY_IMPORTANT");
		const { remaining: afterSystemReminder } = this.extractTaggedBlocks(afterExtremelyImportant, "system-reminder");
		return afterSystemReminder.trim().length === 0;
	}

	/** Returns true when message text is only Codex context tags (no user-visible content). */
	private isCodexContextOnlyMessage(message: EnhancedMessageParam): boolean {
		if (!Array.isArray(message.content) || message.content.length === 0) {
			return false;
		}

		return message.content.every((block) => {
			if (block.type !== "text" || !("text" in block)) {
				return false;
			}
			return this.isCodexContextOnlyText(block.text);
		});
	}

	/** Pulls known Codex context tag blocks from the start of a message string. */
	private extractCodexContextSections(content: string): { sections: Array<{ title: string; blocks: string[] }>; remaining: string } {
		const sections: Array<{ title: string; blocks: string[] }> = [];
		let remaining = content;

		for (const { tag, title } of SimpleConversationView.CODEX_CONTEXT_TAGS) {
			const extracted = this.extractOutermostTaggedBlock(remaining, tag);
			if (extracted.block) {
				sections.push({ title, blocks: [extracted.block] });
				remaining = extracted.remaining;
			}
		}

		return { sections, remaining };
	}

	/**
	 * Parses a plain-text message: main markdown body plus collapsible sections
	 * for Codex context tags, EXTREMELY_IMPORTANT, and system-reminder blocks.
	 */
	private formatStringContent(content: string): TemplateResult {
		const { sections: codexContextSections, remaining: afterCodexContext } =
			this.extractCodexContextSections(content);
		const { blocks: extremelyImportantBlocks, remaining: afterExtremelyImportant } =
			this.extractTaggedBlocks(afterCodexContext, "EXTREMELY_IMPORTANT");
		const { blocks: systemReminderBlocks, remaining: mainContent } = this.extractTaggedBlocks(
			afterExtremelyImportant,
			"system-reminder",
		);

		return html`
			${mainContent ? html`<div class="mt-4 markdown-content">${unsafeHTML(markdownToHtml(mainContent))}</div>` : ""}
			${codexContextSections.map(({ title, blocks }) => this.renderTaggedCollapsibleSections(title, blocks))}
			${this.renderTaggedCollapsibleSections("Extremely Important", extremelyImportantBlocks)}
			${this.renderTaggedCollapsibleSections("System Reminder", systemReminderBlocks)}
		`;
	}

	/** Converts system prompt (string or block array) to HTML via markdown. */
	private formatSystem(system: string | TextBlockParam[] | undefined): string {
		if (!system) return "";

		if (typeof system === "string") {
			return markdownToHtml(system);
		}

		if (Array.isArray(system)) {
			const textContent = system
				.map((block) => {
					if (block.type === "text") {
						return block.text;
					}
					return JSON.stringify(block, null, 2);
				})
				.join("\n");
			return markdownToHtml(textContent);
		}

		return JSON.stringify(system, null, 2);
	}

	/** Renders the final assistant response message for a conversation thread. */
	private formatResponseContent(response: Message): TemplateResult {
		if (!response) return html``;

		if (response.content && Array.isArray(response.content)) {
			return html`
				${response.content.map((block) => {
					if (block.type === "text") {
						return html`<div class="mt-4 markdown-content">${unsafeHTML(markdownToHtml(block.text))}</div>`;
					} else if (block.type === "thinking") {
						const thinkingBlock = block as any;
						return this.renderThinkingBlock(thinkingBlock.thinking || "");
					} else if (block.type === "tool_use") {
						if (block.name === "TodoWrite") {
							return html`
								<div class="mt-4 mb-4">
									<div class="text-vs-type px-4 break-all">${this.getToolDisplayName(block)}</div>
									<div class="bg-vs-bg-secondary mx-4 p-4 text-vs-text">
										${this.renderToolUseContent(block)}
									</div>
								</div>
							`;
						}
						return html`
							<div class="mt-4 mb-4">
								<div
									class="text-vs-type px-4 py-2 break-all cursor-pointer hover:text-white transition-colors"
									@click=${this.toggleContent}
								>
									<span class="mr-2">[+]</span>
									${this.getToolDisplayName(block)}
								</div>
								<div class="bg-vs-bg-secondary mx-4 p-4 text-vs-text hidden">
									${this.renderToolUseContent(block)}
								</div>
							</div>
						`;
					}
					return html`<pre class="mb-4">${JSON.stringify(block, null, 2)}</pre>`;
				})}
			`;
		}

		return html`<pre>${JSON.stringify(response, null, 2)}</pre>`;
	}

	/** Formats `ToolName(param)` header text for single-argument tools. */
	private formatSingleParam(toolName: string, paramValue: string | undefined, paramName: string = ""): TemplateResult {
		return paramValue
			? html`${toolName}(<span class="text-vs-text">${this.unescapeHtml(paramValue)}</span>)`
			: html`${toolName}`;
	}

	/** Formats `ToolName(a, b, ...)` header text for multi-argument tools. */
	private formatMultiParam(toolName: string, params: string[]): TemplateResult {
		return params.length > 0
			? html`${toolName}(<span class="text-vs-text">${params.join(", ")}</span>)`
			: html`${toolName}`;
	}

	/** Decodes HTML entities in tool argument strings for display. */
	private unescapeHtml(str: string): string {
		const div = document.createElement("div");
		div.innerHTML = str;
		return div.textContent || div.innerText || "";
	}

	/** Wraps tool output in a horizontally scrollable container. */
	private wrapInScrollable(content: TemplateResult | string, usePreFormatting: boolean = true): TemplateResult {
		if (usePreFormatting && typeof content === "string") {
			return html`
				<div class="overflow-x-auto">
					<pre class="text-vs-text m-0" style="white-space: pre; font-family: monospace;">${content}</pre>
				</div>
			`;
		}
		return html` <div class="overflow-x-auto">${content}</div> `;
	}

	/**
	 * Generic `[+]/[-]` collapsible section used for system prompt, tools, and tags.
	 *
	 * @param count - Optional item count appended to the title, e.g. "Tools (12)".
	 */
	private renderCollapsibleSection(
		title: string,
		content: TemplateResult,
		options: {
			isExpanded?: boolean;
			titleClasses?: string;
			containerClasses?: string;
			count?: number;
		} = {},
	): TemplateResult {
		const { isExpanded = false, titleClasses = "", containerClasses = "", count } = options;
		const expandedClass = isExpanded ? "" : "hidden";
		const toggleSymbol = isExpanded ? "[-]" : "[+]";
		const displayTitle = count !== undefined ? `${title} (${count})` : title;

		return html`
			<div class="${containerClasses}">
				<div class="cursor-pointer hover:text-white transition-colors ${titleClasses}" @click=${this.toggleContent}>
					<span class="mr-2">${toggleSymbol}</span>
					<span>${displayTitle}</span>
				</div>
				<div class="${expandedClass} mt-4">${content}</div>
			</div>
		`;
	}

	/** Human-readable one-line summary for each known Claude Code tool name. */
	private getToolDisplayName(toolUse: any, toolResult?: any): TemplateResult {
		const toolName = toolUse.name;
		const input = toolUse.input;

		switch (toolName) {
			case "Read":
				return this.formatSingleParam(toolName, input?.file_path);
			case "Bash":
				return this.formatSingleParam(toolName, input?.command);
			case "Write":
				return this.formatSingleParam(toolName, input?.file_path);
			case "Glob":
				if (input?.pattern) {
					const params = [this.unescapeHtml(input.pattern)];
					if (input?.path) params.push(this.unescapeHtml(input.path));
					return this.formatMultiParam(toolName, params);
				}
				return html`${toolName}`;
			case "Grep":
				if (input?.pattern) {
					const params = [this.unescapeHtml(input.pattern)];
					if (input?.include) params.push(this.unescapeHtml(input.include));
					if (input?.path) params.push(this.unescapeHtml(input.path));
					return this.formatMultiParam(toolName, params);
				}
				return html`${toolName}`;
			case "LS":
				if (input?.path) {
					const params = [this.unescapeHtml(input.path)];
					if (input?.ignore) {
						const ignoreStr = input.ignore.map((p: string) => this.unescapeHtml(p)).join(", ");
						params.push(`ignore: ${ignoreStr}`);
					}
					return this.formatMultiParam(toolName, params);
				}
				return html`${toolName}`;
			case "Edit":
				return input?.file_path
					? this.formatSingleParam(toolName, this.unescapeHtml(input.file_path).split("/").pop())
					: html`${toolName}`;
			case "MultiEdit":
				if (input?.file_path) {
					const fileName = this.unescapeHtml(input.file_path).split("/").pop() || input.file_path;
					const editCount = input?.edits ? input.edits.length : 0;
					return this.formatMultiParam(toolName, [fileName, `${editCount} edits`]);
				}
				return html`${toolName}`;
			case "NotebookRead":
				return input?.notebook_path
					? this.formatSingleParam(toolName, this.unescapeHtml(input.notebook_path).split("/").pop())
					: html`${toolName}`;
			case "NotebookEdit":
				if (input?.notebook_path && input?.cell_number !== undefined) {
					const fileName = this.unescapeHtml(input.notebook_path).split("/").pop();
					const cellNum = input.cell_number;
					const mode = input?.edit_mode || "replace";
					return this.formatMultiParam(toolName, [fileName, `cell ${cellNum}`, mode]);
				}
				return html`${toolName}`;
			case "WebFetch":
				return input?.url ? this.formatSingleParam(toolName, input.url) : html`${toolName}`;
			case "WebSearch":
				return input?.query ? this.formatSingleParam(toolName, input.query) : html`${toolName}`;
			default:
				return html`${toolName}`;
		}
	}

	/** Renders expanded tool input — diffs for Edit, todos for TodoWrite, JSON fallback. */
	private renderToolUseContent(toolUse: any): TemplateResult {
		const toolName = toolUse.name;
		const input = toolUse.input;

		if (toolName === "TodoWrite" && input?.todos) {
			const todos = input.todos;

			return this.wrapInScrollable(
				html`${todos.map((todo: any) => {
					const statusClass =
						todo.status === "completed"
							? "line-through text-vs-text"
							: todo.status === "in_progress"
								? "text-green-400"
								: "text-vs-muted";

					return html`
						<div class="overflow-hidden whitespace-nowrap text-ellipsis ${statusClass}">• ${todo.content}</div>
					`;
				})}`,
				false,
			);
		}

		if (toolName === "NotebookEdit" && input?.new_source) {
			const content = input.new_source;

			return this.wrapInScrollable(content);
		}

		if (toolName === "Write" && input?.content) {
			const content = input.content;

			return this.wrapInScrollable(content);
		}

		if (toolName === "MultiEdit" && input?.edits) {
			const edits = input.edits;

			return this.wrapInScrollable(
				html`${edits.map((edit: any, index: number) => {
					const oldStr = edit.old_string;
					const newStr = edit.new_string;

					const diffLines = this.renderDiff(oldStr, newStr);

					return html`
						<div class="mb-4">
							<div class="text-vs-muted mb-2">Edit ${index + 1}:</div>
							<div>${diffLines}</div>
						</div>
					`;
				})}`,
				false,
			);
		}

		if (toolName === "Edit" && input?.old_string && input?.new_string) {
			const oldStr = input.old_string;
			const newStr = input.new_string;

			const diffLines = this.renderDiff(oldStr, newStr);

			return this.wrapInScrollable(html`${diffLines}`, false);
		}

		if (toolName === "WebFetch" && input?.url && input?.prompt) {
			return this.wrapInScrollable(
				html`
					<div class="mb-3">
						<div class="text-vs-muted mb-1">URL:</div>
						<div class="text-vs-text">${input.url}</div>
					</div>
					<div>
						<div class="text-vs-muted mb-1">Prompt:</div>
						<div class="text-vs-text">${input.prompt}</div>
					</div>
				`,
				false,
			);
		}

		if (toolName === "WebSearch" && input?.query) {
			const params = [];
			params.push(html`
				<div class="mb-3">
					<div class="text-vs-muted mb-1">Query:</div>
					<div class="text-vs-text">${input.query}</div>
				</div>
			`);

			if (input?.allowed_domains) {
				params.push(html`
					<div class="mb-3">
						<div class="text-vs-muted mb-1">Allowed Domains:</div>
						<div class="text-vs-text">${input.allowed_domains.join(", ")}</div>
					</div>
				`);
			}

			if (input?.blocked_domains) {
				params.push(html`
					<div class="mb-3">
						<div class="text-vs-muted mb-1">Blocked Domains:</div>
						<div class="text-vs-text">${input.blocked_domains.join(", ")}</div>
					</div>
				`);
			}

			return this.wrapInScrollable(html`${params}`, false);
		}

		// Default: show JSON parameters
		return this.wrapInScrollable(JSON.stringify(input, null, 2));
	}

	/** Collapsible tool_result output plus optional raw tool_use JSON dump. */
	private renderToolResult(toolResult: any, toolUse?: any): TemplateResult {
		return html`
			<div class="mb-4">
				<div
					class="text-vs-muted px-4 pb-0 cursor-pointer hover:text-white transition-colors"
					@click=${this.toggleContent}
				>
					<span class="mr-2">[+]</span>
					Tool Result ${toolResult?.is_error ? "❌" : "✅"}
				</div>
				<div class="bg-vs-bg-secondary mx-4 p-4 text-vs-text hidden overflow-x-auto">
					<pre class="whitespace-pre overflow-x-auto" style="white-space: pre; font-family: monospace;">
${typeof toolResult.content === "string" ? toolResult.content : JSON.stringify(toolResult.content, null, 2)}</pre
					>
				</div>
				${toolUse
					? html`
							<div>
								<div
									class="text-vs-muted px-4 cursor-pointer hover:text-white transition-colors"
									@click=${this.toggleContent}
								>
									<span class="mr-2">[+]</span>
									Raw Tool Call
								</div>
								<div class="bg-vs-bg-secondary mx-4 p-4 text-vs-text hidden">
									${this.wrapInScrollable(JSON.stringify(toolUse, null, 2))}
								</div>
							</div>
						`
					: ""}
			</div>
		`;
	}

	/** Standard layout wrapper for a tool header, body, and optional result. */
	private renderToolContainer(
		toolUse: any,
		toolResult?: any,
		options: {
			isCollapsible?: boolean;
			isCollapsed?: boolean;
			isClickToExpand?: boolean;
			customContent?: TemplateResult;
		} = {},
	): TemplateResult {
		const { isCollapsible = false, isCollapsed = false, isClickToExpand = false, customContent } = options;

		const contentDiv = customContent || html`${this.renderToolUseContent(toolUse)}`;
		const headerClasses = isClickToExpand
			? "text-vs-type px-4 break-all cursor-pointer hover:text-white transition-colors"
			: "text-vs-type px-4 break-all";
		const contentClasses = isCollapsed
			? "bg-vs-bg-secondary mx-4 p-4 text-vs-text hidden"
			: "bg-vs-bg-secondary mx-4 p-4 text-vs-text";

		return html`
			<div class="mt-4 mb-4">
				<div class="${headerClasses}" @click=${isClickToExpand ? this.toggleContent : undefined}>
					${isCollapsible ? html`<span class="mr-2">[${isCollapsed ? "+" : "-"}]</span>` : ""}
					${this.getToolDisplayName(toolUse)}
				</div>
				<div class="${contentClasses}">${contentDiv}</div>
				${toolResult ? this.renderToolResult(toolResult, toolUse) : ""}
			</div>
		`;
	}

	/** Shows the first 10 lines of Write tool content with an expand hint. */
	private renderWritePreview(toolUse: any): TemplateResult {
		const input = toolUse.input;
		if (!input?.content) {
			return html`<div class="text-vs-muted">No content</div>`;
		}

		const content = input.content;
		const lines = content.split("\n");
		const preview = lines.slice(0, 10);
		const hasMore = lines.length > 10;

		return html`
			${this.wrapInScrollable(preview.join("\n"))}
			${hasMore ? html`<div class="text-vs-muted">... ${lines.length - 10} more lines (click to expand)</div>` : ""}
		`;
	}

	/** Renders a line-based diff between old and new strings for Edit/MultiEdit tools. */
	private renderDiff(oldStr: string, newStr: string): TemplateResult[] {
		const diff = Diff.diffLines(oldStr, newStr);
		const diffLines = [];

		for (const part of diff) {
			const lines = part.value.split("\n");
			// Remove empty last line from split if it exists
			if (lines[lines.length - 1] === "") {
				lines.pop();
			}

			for (const line of lines) {
				if (part.added) {
					diffLines.push(html`<div class="bg-green-600/20"><pre class="text-vs-text m-0">+ ${line}</pre></div>`);
				} else if (part.removed) {
					diffLines.push(html`<div class="bg-red-600/20"><pre class="text-vs-text m-0">- ${line}</pre></div>`);
				} else {
					diffLines.push(html`<div><pre class="text-vs-text m-0">  ${line}</pre></div>`);
				}
			}
		}

		return diffLines;
	}

	/** Builds the subtitle under each conversation header (message count + API format). */
	private formatMetadataLine(conversation: SimpleConversation): string {
		const messageCount = `${conversation.messages.length + 1} messages`;
		if (conversation.apiFormatDisplay) {
			return `${messageCount} · ${conversation.apiFormatDisplay}`;
		}
		return messageCount;
	}

	/** Returns true when the final request included tool definitions. */
	private hasTools(conversation: SimpleConversation): boolean {
		return !!(conversation.finalPair.request.tools && conversation.finalPair.request.tools.length > 0);
	}

	/** Renders expandable tool schema cards from the request's `tools` array. */
	private renderTools(tools: ToolUnion[]): TemplateResult {
		return html`
			${tools.map((tool) => {
				if ("name" in tool && tool.name) {
					const description = ("description" in tool && tool.description) || "No description";

					return this.renderCollapsibleSection(
						tool.name,
						html`
							<div class="text-vs-text ml-4 mb-3 markdown-content">
								${unsafeHTML(markdownToHtml(description))}
							</div>

							${"input_schema" in tool && tool.input_schema && typeof tool.input_schema === "object"
								? (() => {
										const schema = tool.input_schema as any;
										if (schema.properties) {
											return html`
												<div class="text-vs-muted mb-2">Parameters:</div>
												${Object.entries(schema.properties).map(([paramName, paramDef]) => {
													const def = paramDef as any;
													const required = schema.required?.includes(paramName) ? " (required)" : "";
													const type = def.type ? ` [${def.type}]` : "";
													const desc = def.description ? ` - ${def.description}` : "";
													return html`
														<div class="ml-4 mb-1">
															<span class="text-vs-user">${paramName}</span>
															<span class="text-vs-muted">${type}${required}${desc}</span>
														</div>
													`;
												})}
											`;
										}
										return html``;
									})()
								: html``}
						`,
						{
							titleClasses: "text-vs-type font-bold",
							containerClasses: "mb-4",
							isExpanded: true,
						},
					);
				}
				return html`<pre class="mb-4">${JSON.stringify(tool, null, 2)}</pre>`;
			})}
		`;
	}

	/** Full inner layout for one conversation: system, tools, messages, response. */
	private renderConversationContent(conversation: SimpleConversation): TemplateResult {
		return html`
			<!-- System Prompt (Expandable) -->
			${conversation.system
				? this.renderCollapsibleSection(
						"System Prompt",
						html`<div class="text-vs-text markdown-content mb-4">
							${unsafeHTML(this.formatSystem(conversation.system))}
						</div>`,
						{
							titleClasses: "text-vs-function",
							containerClasses: "px-4 mt-4",
						},
					)
				: ""}

			<!-- Tools (Expandable) -->
			${this.hasTools(conversation)
				? this.renderCollapsibleSection(
						"Tools",
						html`<div class="ml-4">
							<div class="text-vs-text">${this.renderTools(conversation.finalPair.request.tools || [])}</div>
						</div>`,
						{
							titleClasses: "text-vs-type",
							containerClasses: "px-4",
							count: conversation.finalPair.request.tools?.length || 0,
						},
					)
				: ""}

			<!-- Conversation Messages -->
			<div class="px-4 mt-4">
				${conversation.messages
					.filter((message) => !(message as EnhancedMessageParam).hide)
					.map(
						(message, msgIndex) => html`
							<div class="mb-4">
								${this.isCodexContextOnlyMessage(message as EnhancedMessageParam)
									? ""
									: html`
											<div
												class="font-bold uppercase ${message.role === "user" ? "text-vs-user" : "text-vs-assistant"}"
											>
												<span>${message.role}</span>
											</div>
										`}
								<div class="text-vs-text">
									${this.formatContent(message.content, (message as EnhancedMessageParam).toolResults)}
								</div>
							</div>
						`,
					)}

				<!-- Assistant Response -->
				<div class="mb-4">
					<div class="font-bold uppercase text-vs-assistant">
						<span>assistant</span>
					</div>
					<div class="text-vs-text">${this.formatResponseContent(conversation.response)}</div>
				</div>
			</div>
		`;
	}

	render() {
		if (this.conversations.length === 0) {
			return html`<div>No conversations found.</div>`;
		}

		return html`
			<div class="max-w-[60em] mx-auto">
				${this.conversations.map(
					(conversation) => html`
						<div class="mt-8 first:mt-0">
							${conversation.compacted
								? html`
										<!-- Compacted Conversation (Collapsed) -->
										<div
											class="cursor-pointer text-red-400 hover:text-red-300 transition-colors border border-red-700 p-4"
											@click=${this.toggleContent}
										>
											<span class="mr-2">[+]</span>
											<span>Compacted (click to view details)</span>
										</div>
										<div class="hidden mt-8">
											<!-- Conversation Header -->
											<div class="border border-red-700 p-4 mb-0">
												<div class="text-red-400">${Array.from(conversation.models).join(", ")}</div>
												<div class="text-vs-muted">
													${new Date(conversation.metadata.startTime).toLocaleString()}
													<span class="ml-4">${this.formatMetadataLine(conversation)}</span>
												</div>
											</div>
											${this.renderConversationContent(conversation)}
										</div>
									`
								: html`
										<!-- Regular Conversation -->
										<!-- Conversation Header -->
										<div class="border border-vs-highlight p-4 mb-0">
											<div class="text-vs-assistant">${Array.from(conversation.models).join(", ")}</div>
											<div class="text-vs-muted">
												${new Date(conversation.metadata.startTime).toLocaleString()}
												<span class="ml-4">${this.formatMetadataLine(conversation)}</span>
											</div>
										</div>
										${this.renderConversationContent(conversation)}
									`}
						</div>
					`,
				)}
			</div>
		`;
	}
}
