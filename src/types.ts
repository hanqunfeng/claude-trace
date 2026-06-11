/**
 * @file types.ts
 * @description Shared TypeScript interfaces used across the backend and frontend.
 *
 * These types define the shape of logged API traffic (`RawPair`), processed
 * conversation views, HTML generation payloads, and Bedrock-specific event
 * structures. They must stay compatible with the Lit-based frontend viewer
 * embedded in self-contained HTML reports.
 */

/** A single captured HTTP request/response pair written to JSONL logs. */
export interface RawPair {
	request: {
		/** Unix epoch milliseconds when the outbound request was sent. */
		timestamp: number;
		/** HTTP method (typically POST for LLM APIs). */
		method: string;
		/** Full request URL as seen by the interceptor or reverse proxy. */
		url: string;
		/** Request headers; auth tokens may be redacted unless logging sensitive headers. */
		headers: Record<string, string>;
		/** Parsed JSON request body, or raw structure for non-JSON payloads. */
		body: any;
	};
	response: {
		/** Unix epoch milliseconds when the upstream response was received. */
		timestamp: number;
		/** HTTP status code from the upstream API. */
		status_code: number;
		headers: Record<string, string>;
		/** Parsed JSON response body when available. */
		body?: any;
		/** Raw response text (e.g. non-JSON or partially parsed SSE accumulation). */
		body_raw?: string;
		/** Parsed Server-Sent Events for streaming responses. */
		events?: SSEEvent[];
		/** Detected or annotated API wire format for display in the viewer. */
		api_format?: import("./tools/types").ApiFormat;
	} | null; // null when the request was logged without a matching response (orphan)
	/** ISO-8601 timestamp when this pair was persisted to disk. */
	logged_at: string;
	/** Optional human-readable note (used for orphaned requests). */
	note?: string;
}

/** One parsed SSE frame from a streaming LLM response. */
export interface SSEEvent {
	/** SSE event type (e.g. "message_start", "content_block_delta"). */
	event: string;
	/** Parsed JSON payload from the `data:` field. */
	data: any;
	/** ISO-8601 timestamp when this event was observed. */
	timestamp: string;
}

/** Root payload injected into generated HTML reports (`window.claudeData`). */
export interface ClaudeData {
	rawPairs: RawPair[];
	timestamp?: string;
	metadata?: Record<string, any>;
}

/** Input to the HTML generator when building a report from in-memory or file data. */
export interface HTMLGenerationData {
	rawPairs: RawPair[];
	timestamp: string;
	title?: string;
	/** When true, include non-message traffic in the viewer filters. */
	includeAllRequests?: boolean;
	/** Tool identifier for report title/branding ("claude" | "opencode" | "codex"). */
	tool?: string;
}

/**
 * Placeholder keys in the HTML template replaced at build/generation time.
 * Unique suffixes prevent accidental collision with user content in logs.
 */
export interface TemplateReplacements {
	__CLAUDE_LOGGER_BUNDLE_REPLACEMENT_UNIQUE_9487__: string;
	__CLAUDE_LOGGER_DATA_REPLACEMENT_UNIQUE_9487__: string;
	__CLAUDE_LOGGER_TITLE_REPLACEMENT_UNIQUE_9487__: string;
}

/**
 * A conversation reconstructed from one or more RawPairs for the index/summary UI.
 */
export interface ProcessedConversation {
	id: string;
	model: string;
	/** Original API message objects preserved for faithful rendering. */
	messages: any[];
	system?: any;
	latestResponse?: string;
	pairs: RawPair[];
	metadata: {
		startTime: string;
		endTime: string;
		totalPairs: number;
		totalTokens?: number;
		tokenUsage?: {
			input: number;
			output: number;
		};
	};
	/** Duplicate of `pairs` kept for backward compatibility with older viewers. */
	rawPairs: RawPair[];
}

/** Normalized message used by simplified conversation views. */
export interface ProcessedMessage {
	role: "user" | "assistant" | "system";
	content: string;
	thinking?: string;
	toolCalls?: ToolCall[];
	metadata?: {
		timestamp: string;
		model?: string;
	};
}

/** A tool invocation extracted from assistant messages. */
export interface ToolCall {
	id: string;
	type: string;
	name: string;
	input: any;
	result?: any;
	error?: string;
}

/** AWS Bedrock streaming binary envelope (base64-encoded inner JSON). */
export interface BedrockBinaryEvent {
	bytes: string;
	p?: string;
}

/** Token and latency metrics emitted by Bedrock invocations. */
export interface BedrockInvocationMetrics {
	inputTokenCount: number;
	outputTokenCount: number;
	invocationLatency: number;
	firstByteLatency: number;
	cacheReadInputTokenCount?: number;
	cacheWriteInputTokenCount?: number;
}

declare global {
	interface Window {
		/** Populated by HTMLGenerator so the embedded frontend can load trace data. */
		claudeData: ClaudeData;
	}
}
