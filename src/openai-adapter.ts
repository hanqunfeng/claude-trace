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

interface OpenAIMessage {
	role: string;
	content?: string | null | Array<{ type: string; text?: string }>;
	tool_calls?: OpenAIToolCall[];
	tool_call_id?: string;
	name?: string;
}

interface OpenAIToolCall {
	id: string;
	type: string;
	function: {
		name: string;
		arguments: string;
	};
}

interface OpenAITool {
	type: string;
	function: {
		name: string;
		description?: string;
		parameters?: Record<string, unknown>;
	};
}

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

interface OpenAIResponsesBody {
	id?: string;
	model?: string;
	output?: Array<{
		type: string;
		id?: string;
		role?: string;
		content?: Array<{ type: string; text?: string }>;
	}>;
	usage?: {
		input_tokens?: number;
		output_tokens?: number;
		total_tokens?: number;
	};
}

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

function toTextBlocks(content: OpenAIMessage["content"]): TextBlockParam[] {
	if (content == null) {
		return [];
	}
	if (typeof content === "string") {
		return content ? [{ type: "text", text: content }] : [];
	}
	return content
		.filter((part) => part.type === "text" && part.text)
		.map((part) => ({ type: "text" as const, text: part.text! }));
}

function mapOpenAITools(tools: OpenAITool[] | undefined): MessageCreateParams["tools"] {
	if (!tools?.length) {
		return undefined;
	}
	return tools.map((tool) => ({
		name: tool.function.name,
		description: tool.function.description,
		input_schema: tool.function.parameters || { type: "object", properties: {} },
	})) as MessageCreateParams["tools"];
}

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

export function normalizeOpenAIResponsesRequest(body: unknown): MessageCreateParams {
	const req = body as {
		model?: string;
		instructions?: string;
		input?: string | Array<{ role: string; content: string | Array<{ type: string; text?: string }> }>;
		tools?: OpenAITool[];
	};

	const messages: MessageParam[] = [];

	if (typeof req.input === "string") {
		messages.push({ role: "user", content: [{ type: "text", text: req.input }] });
	} else if (Array.isArray(req.input)) {
		for (const item of req.input) {
			messages.push({
				role: item.role === "assistant" ? "assistant" : "user",
				content: toTextBlocks(item.content as OpenAIMessage["content"]),
			});
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

export function parseOpenAIResponsesBody(body: unknown, model = "unknown"): Message {
	const response = body as OpenAIResponsesBody;
	const content: ContentBlock[] = [];

	for (const item of response.output || []) {
		if (item.type === "message" && item.content) {
			for (const part of item.content) {
				if (part.type === "output_text" || part.type === "text") {
					content.push({ type: "text", text: part.text || "", citations: null });
				}
			}
		}
	}

	return {
		id: response.id || "",
		type: "message",
		role: "assistant",
		model: response.model || model,
		content,
		stop_reason: "end_turn",
		stop_sequence: null,
		usage: {
			...emptyUsage(),
			input_tokens: response.usage?.input_tokens || 0,
			output_tokens: response.usage?.output_tokens || 0,
		},
	};
}

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
			// skip
		}
	}

	return chunks;
}

export function buildOpenAIChatCompletionFromSSE(bodyRaw: string, model = "unknown"): OpenAIChatCompletion {
	const chunks = parseSSEDataLines(bodyRaw) as OpenAIChatCompletion[];
	const result: OpenAIChatCompletion = {
		id: "",
		model,
		choices: [{ index: 0, message: { role: "assistant", content: "" }, finish_reason: null }],
		usage: {},
	};

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

export function buildOpenAIResponsesFromSSE(bodyRaw: string, model = "unknown"): OpenAIResponsesBody {
	const chunks = parseSSEDataLines(bodyRaw);
	const result: OpenAIResponsesBody = {
		id: "",
		model,
		output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "" }] }],
		usage: {},
	};

	let text = "";

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
		} else if (type === "response.completed" && record.response) {
			return record.response as OpenAIResponsesBody;
		}
	}

	if (result.output?.[0]?.content?.[0]) {
		result.output[0].content[0].text = text;
	}

	return result;
}

export function parseOpenAIResponse(
	pairResponse: NonNullable<RawPair["response"]>,
	apiFormat: ApiFormat,
	model = "unknown",
): Message {
	if (pairResponse.body && typeof pairResponse.body === "object") {
		const body = pairResponse.body as Record<string, unknown>;
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

export function normalizeOpenAIRequest(body: unknown, apiFormat: ApiFormat): MessageCreateParams {
	if (apiFormat === "openai-responses") {
		return normalizeOpenAIResponsesRequest(body);
	}
	return normalizeOpenAIChatRequest(body);
}

export function resolvePairApiFormat(pair: RawPair): ApiFormat {
	const fromResponse = pair.response?.api_format;
	if (fromResponse && fromResponse !== "unknown") {
		return fromResponse;
	}
	return detectApiFormat(pair);
}

export function extractModelFromPair(pair: RawPair): string {
	const body = pair.request?.body;
	if (body && typeof body === "object" && "model" in body && typeof (body as { model: unknown }).model === "string") {
		return (body as { model: string }).model;
	}
	return "unknown";
}

export { inferApiFormatFromUrl };
