/**
 * @file api-format.ts
 * @description Heuristics for detecting and labeling LLM API wire formats.
 *
 * OpenCode and Codex may proxy Anthropic Messages, OpenAI Chat Completions,
 * or OpenAI Responses APIs. These helpers infer format from npm package names,
 * URL paths, and JSON body shapes for viewer display and parsing decisions.
 */

import type { ApiFormat } from "../tools/types";
import type { RawPair } from "../types";

/**
 * Infer API format from an OpenCode provider npm package name.
 * @param npm - Value from opencode.json provider config (e.g. "@ai-sdk/anthropic")
 */
export function inferApiFormatFromNpm(npm: string): ApiFormat {
	if (npm.includes("anthropic")) {
		return "anthropic";
	}
	if (npm.includes("openai-compatible")) {
		return "openai";
	}
	if (npm.includes("openai")) {
		return "openai-responses";
	}
	return "unknown";
}

/**
 * Infer API format from the request URL path segment.
 * @param url - Full request URL
 */
export function inferApiFormatFromUrl(url: string | undefined): ApiFormat {
	if (!url) {
		return "unknown";
	}
	if (url.includes("/chat/completions")) {
		return "openai";
	}
	if (url.includes("/responses")) {
		return "openai-responses";
	}
	if (url.includes("/messages")) {
		return "anthropic";
	}
	return "unknown";
}

/**
 * Infer API format from JSON request/response body structure.
 * Checks for provider-specific top-level keys and message block shapes.
 * @param body - Parsed JSON body
 */
export function inferApiFormatFromBody(body: unknown): ApiFormat {
	if (!body || typeof body !== "object") {
		return "unknown";
	}
	const record = body as Record<string, unknown>;
	if ("choices" in record) {
		return "openai";
	}
	if ("output" in record && Array.isArray(record.output)) {
		return "openai-responses";
	}
	if ("content" in record && Array.isArray(record.content)) {
		const content = record.content as unknown[];
		if (content.some((block) => typeof block === "object" && block !== null && "type" in block)) {
			return "anthropic";
		}
	}
	if ("messages" in record && Array.isArray(record.messages)) {
		const messages = record.messages as unknown[];
		if (
			messages.some(
				(msg) =>
					typeof msg === "object" &&
					msg !== null &&
					"role" in msg &&
					((msg as { role: string }).role === "tool" ||
						"tool_calls" in (msg as object)),
			)
		) {
			return "openai";
		}
	}
	return "unknown";
}

/** Human-readable labels shown in the HTML viewer and index summaries. */
const API_FORMAT_LABELS: Record<ApiFormat, string> = {
	anthropic: "Anthropic Messages",
	openai: "OpenAI Chat",
	"openai-responses": "OpenAI Responses",
	unknown: "Unknown",
};

/** @param format - Internal ApiFormat enum value */
export function formatApiFormatLabel(format: ApiFormat): string {
	return API_FORMAT_LABELS[format] ?? format;
}

/**
 * Build a display string for conversations that used multiple API formats.
 * @param formats - List of formats detected across pairs in a conversation
 * @returns Single label, "Mixed (...)", or undefined if all unknown
 */
export function formatApiFormatsDisplay(formats: ApiFormat[]): string | undefined {
	const unique = [...new Set(formats.filter((format) => format && format !== "unknown"))];
	if (unique.length === 0) {
		return undefined;
	}
	if (unique.length === 1) {
		return formatApiFormatLabel(unique[0]);
	}
	return `Mixed (${unique.map(formatApiFormatLabel).join(" + ")})`;
}

/**
 * Best-effort API format detection for a logged request/response pair.
 * Prefers explicit proxy annotation, then URL, then request body, then response body.
 * @param pair - One RawPair from JSONL logs
 */
export function detectApiFormat(pair: RawPair): ApiFormat {
	const response = pair.response;
	if (response && "api_format" in response && response.api_format) {
		return response.api_format as ApiFormat;
	}

	const urlFormat = inferApiFormatFromUrl(pair.request?.url);
	if (urlFormat !== "unknown") {
		return urlFormat;
	}

	const requestBodyFormat = inferApiFormatFromBody(pair.request?.body);
	if (requestBodyFormat !== "unknown") {
		return requestBodyFormat;
	}

	return inferApiFormatFromBody(response?.body);
}
