/**
 * @file Root Lit application for the self-contained trace HTML viewer.
 *
 * Reads base64-decoded session data from `window.claudeData`, processes raw
 * pairs into conversations via {@link SharedConversationProcessor}, and
 * switches between conversation, raw, and JSON debug views with model filtering.
 */

import { LitElement, html } from "lit";
import { customElement, state } from "lit/decorators.js";
import { ClaudeData } from "../../src/types";
import {
	SharedConversationProcessor,
	SimpleConversation,
	ProcessedPair,
} from "../../src/report/shared-conversation-processor";

/** Top-level trace viewer shell mounted on `#app` in generated HTML reports. */
@customElement("claude-app")
export class ClaudeApp extends LitElement {
	@state() private data: ClaudeData = { rawPairs: [] };
	@state() private conversations: SimpleConversation[] = [];
	@state() private processedPairs: ProcessedPair[] = [];
	@state() private currentView: "conversations" | "raw" | "json" = "conversations";
	@state() private selectedModels: Set<string> = new Set();

	/**
	 * Render into the light DOM so Tailwind utility classes from the injected
	 * stylesheet apply to child elements (shadow DOM would isolate styles).
	 */
	createRenderRoot() {
		console.log("createRenderRoot");
		return this;
	}

	/** Loads embedded trace data and runs the shared conversation pipeline. */
	connectedCallback() {
		super.connectedCallback();
		this.data = window.claudeData || { rawPairs: [] };
		this.processData();
	}

	/** Normalizes raw pairs and builds conversation threads for the UI. */
	private processData() {
		const start = performance.now();

		// Use shared processor for both processed pairs and conversations
		const processor = new SharedConversationProcessor();

		// Process raw pairs using shared processor
		this.processedPairs = processor.processRawPairs(this.data.rawPairs);
		// Check for include all requests flag from environment or data
		const includeAllRequests = this.data.metadata?.includeAllRequests || false;
		this.conversations = processor.mergeConversations(this.processedPairs, {
			includeShortConversations: includeAllRequests,
		});

		// Collect every model name seen across conversations, processed pairs, and raw logs
		const conversationModels = new Set(this.conversations.flatMap((c) => Array.from(c.models)));
		const processedPairModels = new Set(this.processedPairs.map((p) => p.model));
		const rawPairModels = new Set(this.data.rawPairs.map((pair) => pair.request.body?.model || "unknown"));
		const allModels = new Set([...conversationModels, ...processedPairModels, ...rawPairModels]);

		// Select all models by default (including haiku)
		this.selectedModels = allModels;
		console.log(`Processed data in ${performance.now() - start}ms`);
	}

	/** Switches the active tab: conversations, raw calls, or JSON debug. */
	private switchView(view: "conversations" | "raw" | "json") {
		this.currentView = view;
	}

	/** Toggles a model in the filter set; triggers Lit re-render via new Set reference. */
	private toggleModel(model: string) {
		const newSelectedModels = new Set(this.selectedModels);
		if (newSelectedModels.has(model)) {
			newSelectedModels.delete(model);
		} else {
			newSelectedModels.add(model);
		}
		this.selectedModels = newSelectedModels;
	}

	/** Conversations where at least one model is currently selected. */
	private get filteredConversations() {
		return this.conversations.filter((c) => {
			// Show conversation if ANY of its models are selected
			return Array.from(c.models).some((model) => this.selectedModels.has(model));
		});
	}

	/** Processed pairs filtered by selected models (JSON debug view). */
	private get filteredProcessedPairs() {
		return this.processedPairs.filter((pair) => this.selectedModels.has(pair.model));
	}

	/** Raw pairs filtered by selected models (unused — raw view shows all). */
	private get filteredRawPairs() {
		return this.data.rawPairs.filter((pair) => {
			const model = pair.request.body?.model || "unknown";
			return this.selectedModels.has(model);
		});
	}

	/** All raw pairs with a non-null response — no model filter applied. */
	private get allRawPairs() {
		// Debug view shows ALL raw pairs without any filtering
		return this.data.rawPairs.filter((pair) => pair.response !== null);
	}

	/** Count of conversations per model for the filter checkbox row. */
	private get modelCounts() {
		const counts = new Map<string, number>();
		this.conversations.forEach((c) => {
			// Count each model used in conversations
			Array.from(c.models).forEach((model) => {
				counts.set(model, (counts.get(model) || 0) + 1);
			});
		});
		return counts;
	}

	/** Resolves the tool-specific brand string for the page header. */
	private getBrandName(): string {
		const tool = this.data.metadata?.tool as string | undefined;
		if (tool === "claude") return "claude-trace";
		if (tool === "opencode") return "opencode-trace";
		if (tool === "codex") return "codex-trace";
		return "trace";
	}

	/** Main layout: header, view tabs, model filters, and active view content. */
	render() {
		const modelCounts = this.modelCounts;
		const filteredConversations = this.filteredConversations;

		return html`
			<div class="min-h-screen bg-vs-bg text-vs-text font-mono">
				<div class="max-w-[60em] mx-auto p-4">
					<div class="mb-8">
						<div class="mb-4 text-center">
							<span class="text-vs-function">~ ${this.getBrandName()}</span>
							<span class="text-vs-muted ml-8">${this.data.timestamp || new Date().toISOString()}</span>
						</div>

						<div class="mb-8 text-center">
							<span
								@click=${() => this.switchView("conversations")}
								class="cursor-pointer mr-12 ${this.currentView === "conversations"
									? "text-vs-nav-active"
									: "text-vs-text hover:text-vs-accent"}"
							>
								conversations (${filteredConversations.length})
							</span>
							<span
								@click=${() => this.switchView("raw")}
								class="cursor-pointer mr-12 ${this.currentView === "raw"
									? "text-vs-nav-active"
									: "text-vs-text hover:text-vs-accent"}"
							>
								raw calls (${this.allRawPairs.length})
							</span>
							<span
								@click=${() => this.switchView("json")}
								class="cursor-pointer mr-12 ${this.currentView === "json"
									? "text-vs-nav-active"
									: "text-vs-text hover:text-vs-accent"}"
							>
								json debug (${this.filteredProcessedPairs.length})
							</span>
						</div>

						${modelCounts.size > 1 && this.currentView !== "raw"
							? html`
									<div class="mb-4 text-center">
										${Array.from(modelCounts.entries()).map(([model, _count]) => {
											return html`
												<span
													@click=${() => this.toggleModel(model)}
													class="cursor-pointer hover:text-vs-accent mr-8"
												>
													${this.selectedModels.has(model) ? "[x]" : "[ ]"} ${model}
												</span>
											`;
										})}
									</div>
								`
							: ""}
					</div>

					<div>
						${this.currentView === "conversations"
							? html`
									<div id="conversations-view">
										${filteredConversations.length === 0
											? html`<div>No conversations found for selected models.</div>`
											: html`<simple-conversation-view
													.conversations=${filteredConversations}
												></simple-conversation-view>`}
									</div>
								`
							: ""}
						${this.currentView === "raw"
							? html`
									<div id="raw-view">
										${this.allRawPairs.length === 0
											? html`<div>No raw pairs found.</div>`
											: html`<raw-pairs-view .rawPairs=${this.allRawPairs}></raw-pairs-view>`}
									</div>
								`
							: ""}
						${this.currentView === "json"
							? html`
									<div id="json-view">
										${this.filteredProcessedPairs.length === 0
											? html`<div>No processed pairs found for selected models.</div>`
											: html`<json-view .processedPairs=${this.filteredProcessedPairs}></json-view>`}
									</div>
								`
							: ""}
					</div>
				</div>
			</div>
		`;
	}
}
