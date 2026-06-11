/**
 * @file OpenAI ↔ Anthropic format adapter.
 *
 * Normalizes OpenAI Chat Completions and Responses API payloads into Anthropic
 * `MessageCreateParams` / `Message` shapes so the shared conversation processor
 * and HTML viewer can render all intercepted providers uniformly.
 */

import type {
	ContentBlock,
	Message,
	MessageCreateParams,
	MessageParam,
	TextBlockParam,
	ToolResultBlockParam,
	ToolUseBlock,
} from "@anthropic-ai/sdk/resources/messages";
import type { ApiFormat } from "./tools/types";
import type { RawPair } from "./types";
import { detectApiFormat, inferApiFormatFromUrl } from "./api-format";

/** OpenAI chat message shape (request or completion choice). */
interface OpenAIMessage {
	role: string;
	content?: string | null | Array<{ type: string; text?: string }>;
	tool_calls?: OpenAIToolCall[];
	tool_call_id?: string;
	name?: string;
}

/** A single tool call emitted by OpenAI chat completions. */
interface OpenAIToolCall {
	id: string;
	type: string;
	function: {
		name: string;
		arguments: string;
	};
}

/** OpenAI function-tool definition in chat or responses requests. */
interface OpenAITool {
	type: string;
	function: {
		name: string;
		description?: string;
		parameters?: Record<string, unknown>;
	};
}

/** Parsed OpenAI chat completion response body. */
interface OpenAIChatCompletion {
	id?: string;
	model?: string;
	choices?: Array<{
		index?: number;
		message?: OpenAIMessage;
		delta?: OpenAIMessage & { role?: string };
		finish_reason?: string | null;
	}>;
	usage?: {
		prompt_tokens?: number;
		completion_tokens?: number;
		total_tokens?: number;
	};
}

/** One item in an OpenAI Responses API `input` array. */
interface OpenAIResponsesInputItem {
	type?: string;
	role?: string;
	id?: string;
	call_id?: string;
	name?: string;
	arguments?: string;
	output?: string;
	content?: string | Array<{ type: string; text?: string }>;
	summary?: Array<{ type: string; text?: string }>;
}

/** One item in an OpenAI Responses API `output` array. */
interface OpenAIResponsesOutputItem {
	type: string;
	id?: string;
	role?: string;
	name?: string;
	arguments?: string;
	call_id?: string;
	content?: Array<{ type: string; text?: string }>;
}

/** Parsed OpenAI Responses API response body. */
interface OpenAIResponsesBody {
	id?: string;
	model?: string;
	output?: OpenAIResponsesOutputItem[];
	usage?: {
		input_tokens?: number;
		output_tokens?: number;
		total_tokens?: number;
	};
}

/** Returns a zeroed Anthropic-style usage object for synthesized messages. */
function emptyUsage() {
	return {
		input_tokens: 0,
		output_tokens: 0,
		cache_creation_input_tokens: null,
		cache_read_input_tokens: null,
		server_tool_use: null,
		service_tier: null,
	};
}

/** OpenAI/Responses content part types that map to Anthropic text blocks. */
const TEXT_PART_TYPES = new Set(["text", "input_text", "output_text"]);

/**
 * Converts OpenAI message content (string or part array) to Anthropic text blocks.
 */
function toTextBlocks(content: OpenAIMessage["content"]): TextBlockParam[] {
	if (content == null) {
		return [];
	}
	if (typeof content === "string") {
		return content ? [{ type: "text", text: content }] : [];
	}
	return content
		.filter((part) => TEXT_PART_TYPES.has(part.type) && part.text)
		.map((part) => ({ type: "text" as const, text: part.text! }));
}

/** Tool definition as seen in Responses API (flat or nested under `function`). */
interface ResponsesApiTool {
	type?: string;
	name?: string;
	description?: string;
	parameters?: Record<string, unknown>;
	function?: {
		name: string;
		description?: string;
		parameters?: Record<string, unknown>;
	};
}

/**
 * Maps OpenAI/Responses tool definitions to Anthropic `tools` array entries.
 */
function mapOpenAITools(tools: ResponsesApiTool[] | OpenAITool[] | undefined): MessageCreateParams["tools"] {
	if (!tools?.length) {
		return undefined;
	}

	const mapped = tools
		.map((tool) => {
			const flat = tool as ResponsesApiTool;
			if (flat.name) {
				return {
					name: flat.name,
					description: flat.description,
					input_schema: flat.parameters || { type: "object", properties: {} },
				};
			}
			const nested = tool as OpenAITool;
			if (nested.function?.name) {
				return {
					name: nested.function.name,
					description: nested.function.description,
					input_schema: nested.function.parameters || { type: "object", properties: {} },
				};
			}
			if (flat.type && flat.type !== "function") {
				return {
					name: flat.type,
					description: flat.description,
					input_schema: flat.parameters || { type: "object", properties: {} },
				};
			}
			return null;
		})
		.filter((tool): tool is NonNullable<typeof tool> => tool !== null);

	return mapped.length > 0 ? (mapped as MessageCreateParams["tools"]) : undefined;
}

/**
 * Normalizes an OpenAI Chat Completions request body to Anthropic `MessageCreateParams`.
 *
 * @param body - Parsed JSON request body from the proxy log.
 * @returns Anthropic-shaped params for the shared conversation processor.
 */
export function normalizeOpenAIChatRequest(body: unknown): MessageCreateParams {
	const req = body as {
		model?: string;
		messages?: OpenAIMessage[];
		tools?: OpenAITool[];
		temperature?: number;
		max_tokens?: number;
		stream?: boolean;
	};

	let system: string | TextBlockParam[] | undefined;
	const messages: MessageParam[] = [];

	for (const msg of req.messages || []) {
		if (msg.role === "system") {
			const blocks = toTextBlocks(msg.content);
			if (blocks.length === 1 && blocks[0].type === "text") {
				system = blocks[0].text;
			} else if (blocks.length > 0) {
				system = blocks;
			}
			continue;
		}

		// OpenAI `tool` role maps to Anthropic user message with tool_result blocks
		if (msg.role === "tool") {
			const toolContent =
				typeof msg.content === "string"
					? msg.content
					: toTextBlocks(msg.content)
							.map((b) => (b.type === "text" ? b.text : ""))
							.join("");
			messages.push({
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: msg.tool_call_id || msg.name || "unknown",
						content: toolContent,
					} as ToolResultBlockParam,
				],
			});
			continue;
		}

		const content: MessageParam["content"] = [];

		const textBlocks = toTextBlocks(msg.content);
		for (const block of textBlocks) {
			content.push(block);
		}

		if (msg.tool_calls?.length) {
			for (const call of msg.tool_calls) {
				let parsedInput: Record<string, unknown> = {};
				try {
					parsedInput = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
				} catch {
					parsedInput = { _raw: call.function.arguments };
				}
				content.push({
					type: "tool_use",
					id: call.id,
					name: call.function.name,
					input: parsedInput,
				} as ToolUseBlock);
			}
		}

		messages.push({
			role: msg.role === "assistant" ? "assistant" : "user",
			content: content.length > 0 ? content : [{ type: "text", text: "" }],
		});
	}

	return {
		model: req.model || "unknown",
		max_tokens: req.max_tokens || 4096,
		messages,
		system,
		tools: mapOpenAITools(req.tools),
	};
}

/**
 * Converts one OpenAI Responses `input` item to Anthropic message content blocks.
 */
function responsesInputToContent(item: OpenAIResponsesInputItem): MessageParam["content"] {
	if (item.type === "function_call") {
		let parsedInput: Record<string, unknown> = {};
		try {
			parsedInput = JSON.parse(item.arguments || "{}") as Record<string, unknown>;
		} catch {
			parsedInput = { _raw: item.arguments };
		}
		return [
			{
				type: "tool_use",
				id: item.call_id || item.id || "unknown",
				name: item.name || "unknown",
				input: parsedInput,
			} as ToolUseBlock,
		];
	}

	if (item.type === "function_call_output") {
		return [
			{
				type: "tool_result",
				tool_use_id: item.call_id || "unknown",
				content: item.output || "",
			} as ToolResultBlockParam,
		];
	}

	// Codex reasoning items become Anthropic thinking blocks
	if (item.type === "reasoning") {
		const summaryText = (item.summary || [])
			.map((part) => (part.type === "summary_text" ? part.text || "" : ""))
			.join("");
		if (summaryText) {
			return [{ type: "thinking", thinking: summaryText, signature: "" }];
		}
		return [];
	}

	if (item.type === "message" || item.role) {
		return toTextBlocks(item.content as OpenAIMessage["content"]);
	}

	return toTextBlocks(item.content as OpenAIMessage["content"]);
}

/**
 * Normalizes an OpenAI Responses API request body to Anthropic `MessageCreateParams`.
 */
export function normalizeOpenAIResponsesRequest(body: unknown): MessageCreateParams {
	const req = body as {
		model?: string;
		instructions?: string;
		input?: string | OpenAIResponsesInputItem[];
		tools?: OpenAITool[];
	};

	const messages: MessageParam[] = [];

	if (typeof req.input === "string") {
		messages.push({ role: "user", content: [{ type: "text", text: req.input }] });
	} else if (Array.isArray(req.input)) {
		for (const item of req.input) {
			const content = responsesInputToContent(item);
			if (!content || (Array.isArray(content) && content.length === 0)) {
				continue;
			}

			const role =
				item.type === "function_call"
					? "assistant"
					: item.type === "function_call_output" || item.type === "reasoning"
						? "user"
						: item.role === "assistant"
							? "assistant"
							: "user";

			messages.push({ role, content });
		}
	}

	return {
		model: req.model || "unknown",
		max_tokens: 4096,
		messages,
		system: req.instructions,
		tools: mapOpenAITools(req.tools),
	};
}

/** Converts a single OpenAI assistant message to an Anthropic `Message`. */
function openAIMessageToAnthropic(message: OpenAIMessage, model: string): Message {
	const content: ContentBlock[] = [];
	const textBlocks = toTextBlocks(message.content);
	for (const block of textBlocks) {
		content.push({ type: "text", text: block.text, citations: null });
	}

	if (message.tool_calls?.length) {
		for (const call of message.tool_calls) {
			let parsedInput: Record<string, unknown> = {};
			try {
				parsedInput = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
			} catch {
				parsedInput = { _raw: call.function.arguments };
			}
			content.push({
				type: "tool_use",
				id: call.id,
				name: call.function.name,
				input: parsedInput,
			});
		}
	}

	return {
		id: "",
		type: "message",
		role: "assistant",
		model,
		content,
		stop_reason: "end_turn",
		stop_sequence: null,
		usage: emptyUsage(),
	};
}

/**
 * Parses a non-streaming OpenAI Chat Completions JSON body into an Anthropic `Message`.
 */
export function parseOpenAIChatCompletionBody(body: unknown, model = "unknown"): Message {
	const completion = body as OpenAIChatCompletion;
	const choiceMessage = completion.choices?.[0]?.message;
	if (!choiceMessage) {
		return {
			id: completion.id || "",
			type: "message",
			role: "assistant",
			model: completion.model || model,
			content: [],
			stop_reason: null,
			stop_sequence: null,
			usage: {
				...emptyUsage(),
				input_tokens: completion.usage?.prompt_tokens || 0,
				output_tokens: completion.usage?.completion_tokens || 0,
			},
		};
	}

	const message = openAIMessageToAnthropic(choiceMessage, completion.model || model);
	message.id = completion.id || "";
	message.usage = {
		...emptyUsage(),
		input_tokens: completion.usage?.prompt_tokens || 0,
		output_tokens: completion.usage?.completion_tokens || 0,
	};
	const finishReason = completion.choices?.[0]?.finish_reason;
	message.stop_reason = finishReason === "tool_calls" ? "tool_use" : finishReason === "stop" ? "end_turn" : null;
	return message;
}

/** Maps one OpenAI Responses output item to Anthropic content blocks. */
function parseResponsesOutputItem(item: OpenAIResponsesOutputItem): ContentBlock[] {
	const blocks: ContentBlock[] = [];

	if (item.type === "message" && item.content) {
		for (const part of item.content) {
			if (part.type === "output_text" || part.type === "text") {
				blocks.push({ type: "text", text: part.text || "", citations: null });
			}
		}
		return blocks;
	}

	if (item.type === "function_call") {
		let parsedInput: Record<string, unknown> = {};
		try {
			parsedInput = JSON.parse(item.arguments || "{}") as Record<string, unknown>;
		} catch {
			parsedInput = { _raw: item.arguments };
		}
		blocks.push({
			type: "tool_use",
			id: item.call_id || item.id || "unknown",
			name: item.name || "unknown",
			input: parsedInput,
		});
		return blocks;
	}

	if (item.type === "reasoning") {
		const summaryText = (item.content || [])
			.map((part) => (part.type === "summary_text" ? part.text || "" : ""))
			.join("");
		if (summaryText) {
			blocks.push({ type: "thinking", thinking: summaryText, signature: "" });
		}
	}

	return blocks;
}

/**
 * Parses a non-streaming OpenAI Responses API JSON body into an Anthropic `Message`.
 */
export function parseOpenAIResponsesBody(body: unknown, model = "unknown"): Message {
	const response = body as OpenAIResponsesBody;
	const content: ContentBlock[] = [];
	let hasToolUse = false;

	for (const item of response.output || []) {
		const blocks = parseResponsesOutputItem(item);
		if (item.type === "function_call") {
			hasToolUse = true;
		}
		content.push(...blocks);
	}

	return {
		id: response.id || "",
		type: "message",
		role: "assistant",
		model: response.model || model,
		content,
		stop_reason: hasToolUse ? "tool_use" : "end_turn",
		stop_sequence: null,
		usage: {
			...emptyUsage(),
			input_tokens: response.usage?.input_tokens || 0,
			output_tokens: response.usage?.output_tokens || 0,
		},
	};
}

/**
 * Extracts JSON payloads from SSE `data:` lines in a raw response body.
 */
function parseSSEDataLines(bodyRaw: string): unknown[] {
	const chunks: unknown[] = [];
	const lines = bodyRaw.split("\n");

	for (const line of lines) {
		if (!line.startsWith("data: ")) {
			continue;
		}
		const data = line.substring(6).trim();
		if (data === "[DONE]") {
			break;
		}
		try {
			chunks.push(JSON.parse(data));
		} catch {
			// skip malformed lines
		}
	}

	return chunks;
}

/**
 * Reconstructs a complete OpenAI Chat Completion object from streamed SSE chunks.
 */
export function buildOpenAIChatCompletionFromSSE(bodyRaw: string, model = "unknown"): OpenAIChatCompletion {
	const chunks = parseSSEDataLines(bodyRaw) as OpenAIChatCompletion[];
	const result: OpenAIChatCompletion = {
		id: "",
		model,
		choices: [{ index: 0, message: { role: "assistant", content: "" }, finish_reason: null }],
		usage: {},
	};

	// Tool calls may arrive in multiple delta chunks keyed by index
	const toolCalls = new Map<number, OpenAIToolCall>();
	let content = "";

	for (const chunk of chunks) {
		if (chunk.id) {
			result.id = chunk.id;
		}
		if (chunk.model) {
			result.model = chunk.model;
		}
		if (chunk.usage) {
			result.usage = { ...result.usage, ...chunk.usage };
		}

		const choice = chunk.choices?.[0];
		if (!choice) {
			continue;
		}

		if (choice.finish_reason) {
			result.choices![0].finish_reason = choice.finish_reason;
		}

		const delta = choice.delta;
		if (!delta) {
			continue;
		}

		if (typeof delta.content === "string") {
			content += delta.content;
		}

		if (delta.tool_calls) {
			for (const tc of delta.tool_calls) {
				const index = (tc as { index?: number }).index ?? 0;
				if (!toolCalls.has(index)) {
					toolCalls.set(index, {
						id: tc.id || "",
						type: "function",
						function: { name: tc.function?.name || "", arguments: "" },
					});
				}
				const existing = toolCalls.get(index)!;
				if (tc.id) {
					existing.id = tc.id;
				}
				if (tc.function?.name) {
					existing.function.name = tc.function.name;
				}
				if (tc.function?.arguments) {
					existing.function.arguments += tc.function.arguments;
				}
			}
		}
	}

	const message: OpenAIMessage = { role: "assistant", content };
	if (toolCalls.size > 0) {
		message.tool_calls = [...toolCalls.entries()]
			.sort(([a], [b]) => a - b)
			.map(([, tc]) => tc);
	}

	result.choices![0].message = message;
	return result;
}

/**
 * Reconstructs an OpenAI Responses body from streamed SSE events.
 * Returns early when a `response.completed` event carries the full response.
 */
export function buildOpenAIResponsesFromSSE(bodyRaw: string, model = "unknown"): OpenAIResponsesBody {
	const chunks = parseSSEDataLines(bodyRaw);
	const result: OpenAIResponsesBody = {
		id: "",
		model,
		output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "" }] }],
		usage: {},
	};

	let text = "";
	const functionCalls = new Map<string, OpenAIResponsesOutputItem>();

	for (const chunk of chunks) {
		const record = chunk as Record<string, unknown>;
		if (typeof record.id === "string") {
			result.id = record.id;
		}
		if (typeof record.model === "string") {
			result.model = record.model;
		}
		if (record.usage && typeof record.usage === "object") {
			result.usage = { ...result.usage, ...(record.usage as OpenAIResponsesBody["usage"]) };
		}

		const type = record.type;
		if (type === "response.output_text.delta" && typeof record.delta === "string") {
			text += record.delta;
		} else if (type === "response.function_call_arguments.delta") {
			const itemId = typeof record.item_id === "string" ? record.item_id : "default";
			if (!functionCalls.has(itemId)) {
				functionCalls.set(itemId, {
					type: "function_call",
					id: itemId,
					call_id: itemId,
					name: "",
					arguments: "",
				});
			}
			const call = functionCalls.get(itemId)!;
			if (typeof record.delta === "string") {
				call.arguments = (call.arguments || "") + record.delta;
			}
		} else if (type === "response.output_item.added" && record.item) {
			const item = record.item as OpenAIResponsesOutputItem;
			if (item.type === "function_call") {
				const itemId = item.call_id || item.id || "default";
				functionCalls.set(itemId, { ...item, arguments: item.arguments || "" });
			}
		} else if (type === "response.completed" && record.response) {
			// Prefer the terminal snapshot when the provider sends it
			return record.response as OpenAIResponsesBody;
		}
	}

	if (result.output?.[0]?.content?.[0]) {
		result.output[0].content[0].text = text;
	}

	if (functionCalls.size > 0) {
		result.output = [
			...(text ? [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }] : []),
			...functionCalls.values(),
		];
	}

	return result;
}

/**
 * Parses a logged response (JSON body or SSE raw) into an Anthropic `Message`.
 * Dispatches on detected API format and whether the body is already Anthropic-shaped.
 */
export function parseOpenAIResponse(
	pairResponse: NonNullable<RawPair["response"]>,
	apiFormat: ApiFormat,
	model = "unknown",
): Message {
	if (pairResponse.body && typeof pairResponse.body === "object") {
		const body = pairResponse.body as Record<string, unknown>;
		// Already normalized to Anthropic shape (e.g. by proxy)
		if ("role" in body && "content" in body && Array.isArray(body.content)) {
			return body as unknown as Message;
		}
		if (apiFormat === "openai-responses" || ("output" in body && Array.isArray(body.output))) {
			return parseOpenAIResponsesBody(body, model);
		}
		if ("choices" in body) {
			return parseOpenAIChatCompletionBody(body, model);
		}
	}

	if (pairResponse.body_raw) {
		if (apiFormat === "openai-responses") {
			const built = buildOpenAIResponsesFromSSE(pairResponse.body_raw, model);
			return parseOpenAIResponsesBody(built, model);
		}
		const built = buildOpenAIChatCompletionFromSSE(pairResponse.body_raw, model);
		return parseOpenAIChatCompletionBody(built, model);
	}

	throw new Error("No OpenAI response body available");
}

/**
 * Normalizes an OpenAI request body to Anthropic `MessageCreateParams`
 * based on the detected API format.
 */
export function normalizeOpenAIRequest(body: unknown, apiFormat: ApiFormat): MessageCreateParams {
	if (apiFormat === "openai-responses") {
		return normalizeOpenAIResponsesRequest(body);
	}
	return normalizeOpenAIChatRequest(body);
}

/**
 * Resolves the API format for a raw pair, preferring the value stamped at log time.
 */
export function resolvePairApiFormat(pair: RawPair): ApiFormat {
	const fromResponse = pair.response?.api_format;
	if (fromResponse && fromResponse !== "unknown") {
		return fromResponse;
	}
	return detectApiFormat(pair);
}

/** Extracts the model id string from a raw pair's request body. */
export function extractModelFromPair(pair: RawPair): string {
	const body = pair.request?.body;
	if (body && typeof body === "object" && "model" in body && typeof (body as { model: unknown }).model === "string") {
		return (body as { model: string }).model;
	}
	return "unknown";
}

export { inferApiFormatFromUrl };
