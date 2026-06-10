import type { ApiFormat } from "./tools/types";
import type { RawPair } from "./types";

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

const API_FORMAT_LABELS: Record<ApiFormat, string> = {
	anthropic: "Anthropic Messages",
	openai: "OpenAI Chat",
	"openai-responses": "OpenAI Responses",
	unknown: "Unknown",
};

export function formatApiFormatLabel(format: ApiFormat): string {
	return API_FORMAT_LABELS[format] ?? format;
}

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
