/**
 * @file shared-conversation-processor.test.ts
 *
 * Unit tests for conversation merging and token usage aggregation in
 * `shared-conversation-processor.ts`.
 *
 * @see ../src/report/shared-conversation-processor.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Message, MessageCreateParams } from "@anthropic-ai/sdk/resources/messages";
import {
	aggregateUsageFromPairs,
	ProcessedPair,
	SharedConversationProcessor,
} from "../src/report/shared-conversation-processor";

/** Minimal ProcessedPair stub for usage aggregation tests. */
function makePair(
	timestamp: string,
	usage: Message["usage"] | undefined,
): ProcessedPair {
	return {
		id: timestamp,
		timestamp,
		request: { model: "claude-test", messages: [] } as MessageCreateParams,
		response: {
			id: "msg_test",
			type: "message",
			role: "assistant",
			model: "claude-test",
			content: [{ type: "text", text: "ok" }],
			stop_reason: "end_turn",
			usage,
		} as Message,
		model: "claude-test",
		isStreaming: false,
	};
}

describe("aggregateUsageFromPairs", () => {
	/**
	 * Empty pair lists should yield zeroed usage with null cache fields.
	 */
	it("returns zeros for an empty pair list", () => {
		const usage = aggregateUsageFromPairs([]);

		assert.equal(usage.lastTurnInputTokens, 0);
		assert.equal(usage.sessionOutputTokens, 0);
		assert.equal(usage.cacheReadTokens, null);
		assert.equal(usage.cacheCreationTokens, null);
	});

	/**
	 * Single-pair threads should mirror that pair's usage on both last-turn
	 * and session totals.
	 */
	it("uses the only pair for last-turn and session output totals", () => {
		const usage = aggregateUsageFromPairs([
			makePair("2026-01-01T00:00:00.000Z", {
				input_tokens: 42,
				output_tokens: 18,
				cache_creation_input_tokens: null,
				cache_read_input_tokens: null,
			}),
		]);

		assert.equal(usage.lastTurnInputTokens, 42);
		assert.equal(usage.lastTurnOutputTokens, 18);
		assert.equal(usage.sessionOutputTokens, 18);
		assert.equal(usage.inputTokens, 42);
		assert.equal(usage.outputTokens, 18);
		assert.equal(usage.totalTokens, 18);
	});

	/**
	 * Multi-pair threads sum output tokens but keep the chronologically last
	 * pair's input and cache metrics.
	 */
	it("sums output across pairs and keeps last-turn input and cache", () => {
		const usage = aggregateUsageFromPairs([
			makePair("2026-01-01T00:00:00.000Z", {
				input_tokens: 100,
				output_tokens: 50,
				cache_creation_input_tokens: null,
				cache_read_input_tokens: null,
			}),
			makePair("2026-01-01T00:01:00.000Z", {
				input_tokens: 500,
				output_tokens: 80,
				cache_creation_input_tokens: 10,
				cache_read_input_tokens: 38_000,
			}),
		]);

		assert.equal(usage.lastTurnInputTokens, 500);
		assert.equal(usage.lastTurnOutputTokens, 80);
		assert.equal(usage.sessionOutputTokens, 130);
		assert.equal(usage.cacheReadTokens, 38_000);
		assert.equal(usage.cacheCreationTokens, 10);
	});

	/**
	 * Pairs passed out of order should still resolve last-turn usage by timestamp.
	 */
	it("sorts pairs by timestamp before picking the last turn", () => {
		const usage = aggregateUsageFromPairs([
			makePair("2026-01-01T00:02:00.000Z", {
				input_tokens: 900,
				output_tokens: 20,
				cache_creation_input_tokens: null,
				cache_read_input_tokens: null,
			}),
			makePair("2026-01-01T00:00:00.000Z", {
				input_tokens: 100,
				output_tokens: 10,
				cache_creation_input_tokens: null,
				cache_read_input_tokens: null,
			}),
		]);

		assert.equal(usage.lastTurnInputTokens, 900);
		assert.equal(usage.sessionOutputTokens, 30);
	});
});

describe("SharedConversationProcessor.mergeConversations", () => {
	/**
	 * End-to-end check that merged conversation metadata carries aggregated usage.
	 */
	it("populates metadata usage fields on merged conversations", () => {
		const processor = new SharedConversationProcessor();
		const pairs: ProcessedPair[] = [
			{
				id: "pair-1",
				timestamp: "2026-01-01T00:00:00.000Z",
				request: {
					model: "claude-test",
					messages: [{ role: "user", content: "hello" }],
				} as MessageCreateParams,
				response: {
					id: "msg_1",
					type: "message",
					role: "assistant",
					model: "claude-test",
					content: [{ type: "text", text: "hi" }],
					stop_reason: "end_turn",
					usage: {
						input_tokens: 10,
						output_tokens: 5,
						cache_creation_input_tokens: null,
						cache_read_input_tokens: null,
					},
				} as Message,
				model: "claude-test",
				isStreaming: false,
			},
			{
				id: "pair-2",
				timestamp: "2026-01-01T00:01:00.000Z",
				request: {
					model: "claude-test",
					messages: [
						{ role: "user", content: "hello" },
						{ role: "assistant", content: "hi" },
						{ role: "user", content: "again" },
					],
				} as MessageCreateParams,
				response: {
					id: "msg_2",
					type: "message",
					role: "assistant",
					model: "claude-test",
					content: [{ type: "text", text: "sure" }],
					stop_reason: "end_turn",
					usage: {
						input_tokens: 25,
						output_tokens: 7,
						cache_creation_input_tokens: null,
						cache_read_input_tokens: null,
					},
				} as Message,
				model: "claude-test",
				isStreaming: false,
			},
		];

		const conversations = processor.mergeConversations(pairs, { includeShortConversations: true });
		assert.equal(conversations.length, 1);

		const metadata = conversations[0].metadata;
		assert.equal(metadata.totalPairs, 2);
		assert.equal(metadata.lastTurnInputTokens, 25);
		assert.equal(metadata.sessionOutputTokens, 12);
		assert.equal(metadata.outputTokens, 12);
	});
});
