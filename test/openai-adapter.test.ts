import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	buildOpenAIChatCompletionFromSSE,
	normalizeOpenAIChatRequest,
	normalizeOpenAIResponsesRequest,
	parseOpenAIChatCompletionBody,
} from "../src/openai-adapter";

describe("normalizeOpenAIChatRequest", () => {
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

describe("parseOpenAIChatCompletionBody", () => {
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

describe("normalizeOpenAIResponsesRequest", () => {
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

describe("buildOpenAIChatCompletionFromSSE", () => {
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
