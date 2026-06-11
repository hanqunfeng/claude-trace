/**
 * @file openai-adapter.test.ts
 *
 * Unit tests for OpenAI ↔ Anthropic format conversion in `openai-adapter.ts`.
 *
 * The reverse proxy intercepts provider-native request/response bodies. For
 * unified logging and HTML report rendering, non-Anthropic traffic (OpenCode
 * OpenAI-compatible providers, Codex OpenAI Responses API) is normalized into
 * Anthropic Messages shape so the shared conversation processor can parse all
 * traffic through one code path.
 *
 * This suite covers:
 * - OpenAI Chat Completions request normalization (`normalizeOpenAIChatRequest`)
 * - Non-streaming completion response parsing (`parseOpenAIChatCompletionBody`)
 * - OpenAI Responses API / Codex request shape (`normalizeOpenAIResponsesRequest`)
 * - SSE stream reassembly into a synthetic non-streaming body (`buildOpenAIChatCompletionFromSSE`)
 *
 * @see ../src/adapt/openai-adapter.ts — format conversion implementation
 * @see ../src/shared-conversation-processor.ts — consumer of normalized message shapes
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	buildOpenAIChatCompletionFromSSE,
	normalizeOpenAIChatRequest,
	normalizeOpenAIResponsesRequest,
	parseOpenAIChatCompletionBody,
} from "../src/adapt/openai-adapter";

/**
 * Tests inbound OpenAI Chat Completions JSON → Anthropic Messages request shape.
 *
 * Covers role mapping, system message extraction, and tool call conversion.
 */
describe("normalizeOpenAIChatRequest", () => {
	/**
	 * A leading `system` role message should be lifted to the top-level `system`
	 * field; remaining user messages should be preserved in `messages`.
	 */
	it("extracts system message and maps user content", () => {
		const request = normalizeOpenAIChatRequest({
			model: "deepseek-chat",
			messages: [
				{ role: "system", content: "You are helpful." },
				{ role: "user", content: "Hello" },
			],
		});

		assert.equal(request.model, "deepseek-chat");
		assert.equal(request.system, "You are helpful.");
		assert.equal(request.messages.length, 1);
		assert.equal(request.messages[0].role, "user");
	});

	/**
	 * Assistant messages with OpenAI `tool_calls` arrays should become Anthropic
	 * `tool_use` content blocks with preserved function name and arguments.
	 */
	it("maps assistant tool_calls to tool_use blocks", () => {
		const request = normalizeOpenAIChatRequest({
			model: "gpt-4.1",
			messages: [
				{
					role: "assistant",
					content: "",
					tool_calls: [
						{
							id: "call_1",
							type: "function",
							function: { name: "read_file", arguments: "{\"path\":\"a.ts\"}" },
						},
					],
				},
			],
		});

		const content = request.messages[0].content;
		assert.ok(Array.isArray(content));
		const toolUse = content.find((block) => typeof block === "object" && block.type === "tool_use");
		assert.equal((toolUse as { name?: string })?.name, "read_file");
	});
});

/**
 * Tests non-streaming OpenAI Chat Completions JSON → Anthropic assistant message.
 *
 * Verifies text content, finish reason, and token usage field mapping.
 */
describe("parseOpenAIChatCompletionBody", () => {
	/**
	 * A standard non-streaming completion should map choice text, finish reason,
	 * and `usage` token counts to Anthropic message and usage fields.
	 */
	it("maps non-streaming completion to Anthropic message", () => {
		const message = parseOpenAIChatCompletionBody(
			{
				id: "cmpl-1",
				model: "deepseek-chat",
				choices: [
					{
						message: { role: "assistant", content: "Hi there" },
						finish_reason: "stop",
					},
				],
				usage: { prompt_tokens: 10, completion_tokens: 5 },
			},
			"deepseek-chat",
		);

		assert.equal(message.role, "assistant");
		assert.equal(message.content[0].type, "text");
		assert.equal((message.content[0] as { text: string }).text, "Hi there");
		assert.equal(message.usage.input_tokens, 10);
		assert.equal(message.usage.output_tokens, 5);
	});
});

/**
 * Tests OpenAI Responses API (Codex) request JSON → Anthropic Messages shape.
 *
 * Codex uses a different request schema (`instructions`, `input`, flat `tools`)
 * than Chat Completions; normalization must handle both.
 */
describe("normalizeOpenAIResponsesRequest", () => {
	/**
	 * Codex flat tool definitions and `input_text` content blocks should
	 * normalize to Anthropic `tools` and user message text content.
	 */
	it("parses Codex flat tools and input_text content", () => {
		const request = normalizeOpenAIResponsesRequest({
			model: "deepseek-v4-flash",
			instructions: "You are Codex.",
			input: [
				{
					type: "message",
					role: "user",
					content: [{ type: "input_text", text: "hello" }],
				},
			],
			tools: [
				{
					type: "function",
					name: "exec_command",
					description: "Runs a command.",
					parameters: { type: "object", properties: { cmd: { type: "string" } } },
				},
			],
		});

		assert.equal(request.model, "deepseek-v4-flash");
		assert.equal(request.system, "You are Codex.");
		assert.equal(request.messages.length, 1);
		assert.equal(request.messages[0].role, "user");
		const text = request.messages[0].content?.[0];
		assert.equal((text as { text?: string })?.text, "hello");
		assert.equal(request.tools?.[0]?.name, "exec_command");
	});
});

/**
 * Tests reassembly of OpenAI Chat Completions SSE chunks into a synthetic
 * non-streaming completion body suitable for logging and report parsing.
 */
describe("buildOpenAIChatCompletionFromSSE", () => {
	/**
	 * Incremental `delta.content` fragments across multiple SSE `data:` lines
	 * should concatenate into the full assistant message text.
	 */
	it("accumulates streaming text deltas", () => {
		const sse = [
			"data: {\"id\":\"cmpl-1\",\"choices\":[{\"delta\":{\"content\":\"Hel\"}}]}",
			"data: {\"choices\":[{\"delta\":{\"content\":\"lo\"}}]}",
			"data: [DONE]",
		].join("\n");

		const completion = buildOpenAIChatCompletionFromSSE(sse, "deepseek-chat");
		assert.equal(completion.choices?.[0]?.message?.content, "Hello");
	});
});
