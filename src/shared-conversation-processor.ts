/**
 * @file Shared conversation parsing for frontend and backend.
 *
 * Converts raw JSONL request/response pairs into normalized Anthropic-shaped
 * messages, groups them into conversation threads, pairs tool_use with
 * tool_result blocks, and detects compacted (summarized) conversations.
 *
 * Used by both the Lit HTML viewer and the CLI index generator so parsing
 * behavior stays identical across surfaces.
 */

import type {
    ContentBlock,
    ContentBlockParam,
    Message,
    MessageCreateParams,
    MessageParam,
    RawMessageStreamEvent,
    TextBlock,
    TextBlockParam,
    ToolResultBlockParam,
    ThinkingBlock,
    ToolUseBlock as ToolUseBlockType,
} from "@anthropic-ai/sdk/resources/messages";
import type { ApiFormat } from "./tools/types";
import type { RawPair, BedrockInvocationMetrics } from "./types";
import { formatApiFormatsDisplay } from "./api-format";
import {
    extractModelFromPair,
    normalizeOpenAIRequest,
    parseOpenAIResponse,
    resolvePairApiFormat,
} from "./openai-adapter";

/** A single logged API round-trip normalized for display and grouping. */
export interface ProcessedPair {
    id: string;
    timestamp: string;
    request: MessageCreateParams;
    response: Message;
    model: string;
    isStreaming: boolean;
    /** Raw SSE or Bedrock event-stream body preserved for debug views. */
    rawStreamData?: string;
    /** Whether streaming data used Anthropic SSE or AWS Bedrock binary format. */
    streamFormat?: "standard" | "bedrock" | null;
    /** Detected upstream API format when known at log or parse time. */
    apiFormat?: ApiFormat;
}

/** Message with paired tool results attached and optional UI hide flag. */
export interface EnhancedMessageParam extends MessageParam {
    /** Tool results keyed by `tool_use_id`, hoisted onto the assistant turn. */
    toolResults?: Record<string, ToolResultBlockParam>;
    /** When true, the message is tool-result-only and hidden in the UI. */
    hide?: boolean;
}

/** One logical conversation thread merged from multiple API pairs. */
export interface SimpleConversation {
    id: string;
    models: Set<string>;
    system?: string | TextBlockParam[];
    messages: EnhancedMessageParam[];
    response: Message;
    /** All API pairs that belong to this thread, sorted by time. */
    allPairs: ProcessedPair[];
    /** The pair with the longest message list — treated as the thread snapshot. */
    finalPair: ProcessedPair;
    /** True when this thread was detected as a post-compaction summary. */
    compacted?: boolean;
    /** Human-readable API format label, e.g. "OpenAI Chat". */
    apiFormatDisplay?: string;
    metadata: {
        startTime: string;
        endTime: string;
        totalPairs: number;
        inputTokens: number;
        outputTokens: number;
        totalTokens: number;
    };
}

/**
 * Parses raw trace pairs and merges them into viewer-ready conversations.
 * Used by both the Lit frontend and the CLI index generator.
 */
export class SharedConversationProcessor {
    /**
     * Converts each {@link RawPair} into a {@link ProcessedPair}.
     *
     * Handles Anthropic JSON, Anthropic/Bedrock SSE, and OpenAI Chat/Responses
     * formats. Pairs missing request/response or failing parse are skipped with
     * a console warning.
     *
     * @param rawPairs - Lines parsed from a session JSONL log.
     * @returns Normalized pairs ready for merging or JSON debug display.
     */
    processRawPairs(rawPairs: RawPair[]): ProcessedPair[] {
        if (!rawPairs || rawPairs.length === 0) {
            return [];
        }

        const processedPairs: ProcessedPair[] = [];

        for (let i = 0; i < rawPairs.length; i++) {
            const pair = rawPairs[i];
            if (!pair?.request || !pair?.response) {
                continue;
            }

            try {
                const apiFormat = resolvePairApiFormat(pair);
                const isOpenAIFormat = apiFormat === "openai" || apiFormat === "openai-responses";
                const isStreaming = !!pair.response.body_raw;
                let response: Message;
                let streamFormat: "standard" | "bedrock" | null = null;
                let request: MessageCreateParams;

                if (isOpenAIFormat) {
                    request = normalizeOpenAIRequest(pair.request.body, apiFormat);
                    response = parseOpenAIResponse(pair.response, apiFormat, extractModelFromPair(pair));
                } else if (pair.response.body_raw) {
                    streamFormat = this.isBedrockResponse(pair.response.body_raw) ? "bedrock" : "standard";
                    response = this.parseStreamingResponse(pair.response.body_raw);
                    request = pair.request.body as MessageCreateParams;
                } else if (pair.response.body) {
                    response = pair.response.body as Message;
                    request = pair.request.body as MessageCreateParams;
                } else {
                    continue;
                }

                const model = this.extractModel(pair);

                processedPairs.push({
                    id: `${pair.request.timestamp || Date.now()}_${Math.random()}`,
                    timestamp: new Date((pair.request.timestamp || Date.now()) * 1000).toISOString(),
                    request,
                    response,
                    model,
                    isStreaming,
                    rawStreamData: pair.response.body_raw,
                    streamFormat,
                    apiFormat: apiFormat !== "unknown" ? apiFormat : undefined,
                });
            } catch (error) {
                console.warn(`Failed to process raw pair at index ${i}:`, error);
                // Continue processing other pairs
            }
        }

        return processedPairs;
    }

    /**
     * Detects AWS Bedrock binary event-stream responses by their leading NUL bytes.
     *
     * @param bodyRaw - Raw response body string from the proxy log.
     */
    private isBedrockResponse(bodyRaw: string): boolean {
        // Bedrock EventStream frames start with a 4-byte total-length prefix of zeroes
        return bodyRaw.startsWith("\u0000\u0000");
    }

    /**
     * Parses Bedrock binary event stream into a synthetic Anthropic {@link Message}.
     *
     * Extracts base64-wrapped JSON events from `event{"bytes":...}` frames and
     * merges Bedrock invocation metrics into usage when present.
     */
    private parseBedrockStreamingResponse(bodyRaw: string): Message {
        if (!bodyRaw || bodyRaw.length === 0) {
            throw new Error("Empty bodyRaw provided to parseBedrockStreamingResponse");
        }

        const events: RawMessageStreamEvent[] = [];
        let bedrockMetrics: BedrockInvocationMetrics | null = null;

        try {
            // Extract JSON payloads from AWS EventStream format
            // The format contains binary headers followed by JSON payloads
            const jsonChunks = this.extractJsonChunksFromEventStream(bodyRaw);

            for (const jsonChunk of jsonChunks) {
                try {
                    const eventPayload = JSON.parse(jsonChunk);

                    // Each frame wraps the Anthropic SSE event JSON in a base64 `bytes` field
                    if (eventPayload.bytes) {
                        const base64Data = eventPayload.bytes;
                        const decodedJson = this.decodeBase64ToUtf8(base64Data);
                        const event = JSON.parse(decodedJson) as RawMessageStreamEvent;
                        events.push(event);
                    }
                } catch (chunkError) {
                    console.warn("Failed to parse JSON chunk:", jsonChunk, chunkError);
                    // Continue with other chunks
                }
            }

            // Extract Bedrock metrics from the last event if present
            bedrockMetrics = this.extractBedrockMetrics(bodyRaw);
        } catch (error) {
            console.error("Failed to parse Bedrock streaming response:", error);
            throw new Error(`Bedrock streaming response parsing failed: ${error}`);
        }

        return this.buildMessageFromEvents(events, bedrockMetrics);
    }

    /**
     * Decodes base64 to UTF-8 in both browser (atob) and Node.js (Buffer).
     *
     * @throws When neither API is available (unlikely in this project's targets).
     */
    private decodeBase64ToUtf8(base64Data: string): string {
        if (typeof window !== "undefined" && typeof atob !== "undefined") {
            return atob(base64Data);
        } else if (typeof Buffer !== "undefined") {
            return Buffer.from(base64Data, "base64").toString("utf-8");
        } else {
            throw new Error("Base64 decoding not supported in this environment");
        }
    }

    /**
     * Scans raw Bedrock event-stream text for `event{"bytes":{...}}` JSON wrappers.
     *
     * Uses brace counting rather than regex to handle nested JSON objects safely.
     */
    private extractJsonChunksFromEventStream(bodyRaw: string): string[] {
        if (!bodyRaw || bodyRaw.length === 0) {
            return [];
        }

        const jsonChunks: string[] = [];
        const pattern = 'event{"bytes":';

        let searchIndex = 0;

        while (searchIndex < bodyRaw.length) {
            const patternIndex = bodyRaw.indexOf(pattern, searchIndex);
            if (patternIndex === -1) {
                break;
            }

            // Start extracting JSON from the '{' after 'event'
            const jsonStartIndex = patternIndex + 5;
            let braceCount = 0;
            let jsonEndIndex = -1;

            for (let i = jsonStartIndex; i < bodyRaw.length; i++) {
                const char = bodyRaw[i];

                if (char === "{") {
                    braceCount++;
                } else if (char === "}") {
                    braceCount--;
                    if (braceCount === 0) {
                        jsonEndIndex = i;
                        break;
                    }
                }
            }

            if (jsonEndIndex !== -1) {
                const jsonChunk = bodyRaw.substring(jsonStartIndex, jsonEndIndex + 1);
                jsonChunks.push(jsonChunk);
                searchIndex = jsonEndIndex + 1;
            } else {
                searchIndex = patternIndex + pattern.length;
            }
        }

        return jsonChunks;
    }

    /**
     * Best-effort extraction of Bedrock token metrics embedded in the raw stream.
     */
    private extractBedrockMetrics(bodyRaw: string): BedrockInvocationMetrics | null {
        try {
            const metricsMatch = bodyRaw.match(/"amazon-bedrock-invocationMetrics":\s*(\{[^}]+\})/);
            if (metricsMatch && metricsMatch[1]) {
                return JSON.parse(metricsMatch[1]) as BedrockInvocationMetrics;
            }
        } catch (e) {
            // Skip invalid metrics
        }
        return null;
    }

    /**
     * Dispatches streaming body parsing to Bedrock or standard Anthropic SSE.
     *
     * @param bodyRaw - Raw `body_raw` field from a logged response.
     * @returns Reconstructed assistant {@link Message}.
     */
    parseStreamingResponse(bodyRaw: string): Message {
        if (this.isBedrockResponse(bodyRaw)) {
            return this.parseBedrockStreamingResponse(bodyRaw);
        } else {
            return this.parseStandardStreamingResponse(bodyRaw);
        }
    }

    /**
     * Parses Anthropic-style `data: {...}` SSE lines into a {@link Message}.
     */
    private parseStandardStreamingResponse(bodyRaw: string): Message {
        if (!bodyRaw || bodyRaw.length === 0) {
            throw new Error("Empty bodyRaw provided to parseStandardStreamingResponse");
        }

        const lines = bodyRaw.split("\n");
        const events: RawMessageStreamEvent[] = [];

        for (const line of lines) {
            if (!line.startsWith("data: ")) continue;

            const data = line.substring(6).trim();
            if (data === "[DONE]") break;

            try {
                const event = JSON.parse(data) as RawMessageStreamEvent;
                events.push(event);
            } catch (e) {
                console.warn("Failed to parse SSE event:", data, e);
            }
        }

        return this.buildMessageFromEvents(events);
    }

    /**
     * Replays streaming events into a complete {@link Message}, accumulating
     * text, thinking, and tool_use deltas and parsing tool JSON at block stop.
     *
     * @param events - Ordered stream events from SSE or Bedrock decode.
     * @param bedrockMetrics - Optional Bedrock token counts overriding usage.
     */
    private buildMessageFromEvents(
        events: RawMessageStreamEvent[],
        bedrockMetrics?: BedrockInvocationMetrics | null,
    ): Message {
        let message: Partial<Message> = {
            id: "",
            type: "message",
            role: "assistant",
            content: [],
            model: "",
            stop_reason: null,
            stop_sequence: null,
            usage: {
                input_tokens: 0,
                output_tokens: 0,
                cache_creation_input_tokens: null,
                cache_read_input_tokens: null,
                server_tool_use: null,
                service_tier: null,
            },
        };

        const contentBlocks: ContentBlock[] = [];
        let currentBlockIndex = -1;

        for (const event of events) {
            switch (event.type) {
                case "message_start":
                    message = { ...message, ...event.message };
                    break;

                case "content_block_start":
                    currentBlockIndex = event.index;
                    contentBlocks[currentBlockIndex] = { ...event.content_block };
                    break;

                case "content_block_delta":
                    if (currentBlockIndex >= 0 && contentBlocks[currentBlockIndex]) {
                        const block = contentBlocks[currentBlockIndex];
                        const delta = event.delta;

                        switch (delta.type) {
                            case "text_delta":
                                if (block.type === "text") {
                                    (block as TextBlock).text = ((block as TextBlock).text || "") + delta.text;
                                }
                                break;

                            case "input_json_delta":
                                if (block.type === "tool_use") {
                                    const toolBlock = block as ToolUseBlockType;
                                    if (typeof toolBlock.input === "string") {
                                        toolBlock.input = toolBlock.input + delta.partial_json;
                                    } else {
                                        (toolBlock.input as any) = delta.partial_json;
                                    }
                                }
                                break;

                            case "thinking_delta":
                                if (block.type === "thinking") {
                                    (block as ThinkingBlock).thinking =
                                        ((block as ThinkingBlock).thinking || "") + delta.thinking;
                                }
                                break;

                            case "signature_delta":
                                if (block.type === "thinking") {
                                    (block as ThinkingBlock).signature =
                                        ((block as ThinkingBlock).signature || "") + delta.signature;
                                }
                                break;

                            case "citations_delta":
                                break;
                        }
                    }
                    break;

                case "content_block_stop":
                    if (currentBlockIndex >= 0 && contentBlocks[currentBlockIndex]) {
                        const block = contentBlocks[currentBlockIndex];
                        if (block.type === "tool_use") {
                            const toolBlock = block as ToolUseBlockType;
                            if (typeof toolBlock.input === "string") {
                                try {
                                    toolBlock.input = JSON.parse(toolBlock.input);
                                } catch (e) {
                                    console.warn("Failed to parse tool input JSON:", toolBlock.input);
                                }
                            }
                        }
                    }
                    break;

                case "message_delta":
                    if (event.delta.stop_reason) {
                        message.stop_reason = event.delta.stop_reason;
                    }
                    if (event.delta.stop_sequence) {
                        message.stop_sequence = event.delta.stop_sequence;
                    }
                    if (event.usage) {
                        // Input tokens are usually sent once; preserve prior value on later deltas
                        const currentInputTokens = message.usage?.input_tokens ?? 0;

                        message.usage = {
                            input_tokens: event.usage.input_tokens ?? currentInputTokens,
                            output_tokens: event.usage.output_tokens ?? message.usage?.output_tokens ?? 0,
                            cache_creation_input_tokens:
                                event.usage.cache_creation_input_tokens ?? message.usage?.cache_creation_input_tokens ?? null,
                            cache_read_input_tokens:
                                event.usage.cache_read_input_tokens ?? message.usage?.cache_read_input_tokens ?? null,
                            server_tool_use: event.usage.server_tool_use ?? message.usage?.server_tool_use ?? null,
                            service_tier: null,
                        };
                    }
                    break;

                case "message_stop":
                    break;
            }
        }

        message.content = contentBlocks.filter((block) => block != null);

        if (bedrockMetrics && message.usage) {
            message.usage.input_tokens = bedrockMetrics.inputTokenCount;
            message.usage.output_tokens = bedrockMetrics.outputTokenCount;
        }

        return message as Message;
    }

    /**
     * Resolves a display model id from Bedrock URL, request body, or response body.
     */
    private extractModel(pair: RawPair): string {
        if (pair.request?.url && pair.request.url.includes("bedrock-runtime")) {
            const urlMatch = pair.request.url.match(/\/model\/([^\/]+)/);
            if (urlMatch && urlMatch[1]) {
                return this.normalizeModelName(urlMatch[1]);
            }
        }

        if (pair.request?.body && typeof pair.request.body === "object" && "model" in pair.request.body) {
            return this.normalizeModelName((pair.request.body as any).model);
        }

        if (pair.response?.body && typeof pair.response.body === "object" && "model" in pair.response.body) {
            return this.normalizeModelName((pair.response.body as any).model);
        }

        return "unknown";
    }

    /**
     * Strips Bedrock inference-profile prefixes for shorter display names.
     */
    private normalizeModelName(modelName: string): string {
        if (!modelName) return "unknown";

        if (modelName.startsWith("us.anthropic.")) {
            const match = modelName.match(/us\.anthropic\.([^:]+)/);
            if (match && match[1]) {
                return match[1];
            }
        }

        return modelName;
    }

    /**
     * Groups {@link ProcessedPair} rows into {@link SimpleConversation} threads.
     *
     * Threading heuristic: same system prompt + model, then bucket by normalized
     * first user message. Within each bucket the pair with the most messages
     * becomes the thread snapshot. Compacted conversations are merged when detected.
     *
     * @param pairs - Normalized pairs from {@link processRawPairs}.
     * @param options.includeShortConversations - Include threads with ≤2 messages.
     * @returns Conversations sorted by start time.
     */
    mergeConversations(
        pairs: ProcessedPair[],
        options: { includeShortConversations?: boolean } = {},
    ): SimpleConversation[] {
        if (!pairs || pairs.length === 0) return [];

        // First split by system prompt + model so unrelated sessions don't merge
        const pairsBySystem = new Map<string, ProcessedPair[]>();

        for (const pair of pairs) {
            const system = pair.request.system;
            const model = pair.model;
            const systemKey = JSON.stringify({ system, model });

            if (!pairsBySystem.has(systemKey)) {
                pairsBySystem.set(systemKey, []);
            }
            pairsBySystem.get(systemKey)!.push(pair);
        }

        const allConversations: SimpleConversation[] = [];

        for (const [, systemPairs] of pairsBySystem) {
            const sortedPairs = [...systemPairs].sort(
                (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
            );

            const conversationThreads = new Map<string, ProcessedPair[]>();

            for (const pair of sortedPairs) {
                const messages = pair.request.messages || [];
                if (messages.length === 0) continue;

                const firstUserMessage = messages[0];
                const normalizedFirstMessage = this.normalizeMessageForGrouping(firstUserMessage);
                const conversationKey = JSON.stringify({ firstMessage: normalizedFirstMessage });
                const keyHash = this.hashString(conversationKey);

                if (!conversationThreads.has(keyHash)) {
                    conversationThreads.set(keyHash, []);
                }
                conversationThreads.get(keyHash)!.push(pair);
            }

            for (const [conversationKey, threadPairs] of conversationThreads) {
                const sortedThreadPairs = [...threadPairs].sort(
                    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
                );

                // Longest message list ≈ latest turn in a multi-request thread
                const finalPair = sortedThreadPairs.reduce((longest, current) => {
                    const currentMessages = current.request.messages || [];
                    const longestMessages = longest.request.messages || [];
                    return currentMessages.length > longestMessages.length ? current : longest;
                });

                const modelsUsed = new Set(sortedThreadPairs.map((pair) => pair.model));
                const enhancedMessages = this.processToolResults(finalPair.request.messages || []);
                const apiFormatDisplay = formatApiFormatsDisplay(
                    sortedThreadPairs.map((pair) => pair.apiFormat || "unknown"),
                );

                const conversation: SimpleConversation = {
                    id: this.hashString(conversationKey),
                    models: modelsUsed,
                    system: finalPair.request.system,
                    messages: enhancedMessages,
                    response: finalPair.response,
                    allPairs: sortedThreadPairs,
                    finalPair: finalPair,
                    apiFormatDisplay,
                    metadata: {
                        startTime: sortedThreadPairs[0].timestamp,
                        endTime: finalPair.timestamp,
                        totalPairs: sortedThreadPairs.length,
                        inputTokens: finalPair.response.usage?.input_tokens || 0,
                        outputTokens: finalPair.response.usage?.output_tokens || 0,
                        totalTokens:
                            (finalPair.response.usage?.input_tokens || 0) + (finalPair.response.usage?.output_tokens || 0),
                    },
                };

                allConversations.push(conversation);
            }
        }

        const mergedConversations = this.detectAndMergeCompactConversations(allConversations);

        const filteredConversations = options.includeShortConversations
            ? mergedConversations
            : mergedConversations.filter((conv) => conv.messages.length > 2);

        return filteredConversations.sort(
            (a, b) => new Date(a.metadata.startTime).getTime() - new Date(b.metadata.startTime).getTime(),
        );
    }

    /**
     * Attaches tool_result blocks to their tool_use messages and hides
     * user turns that contain only orphaned tool results.
     */
    private processToolResults(messages: MessageParam[]): EnhancedMessageParam[] {
        const enhancedMessages: EnhancedMessageParam[] = [];
        const pendingToolUses: Record<string, { messageIndex: number; toolIndex: number }> = {};

        for (let i = 0; i < messages.length; i++) {
            const message = messages[i];
            const enhancedMessage: EnhancedMessageParam = { ...message, toolResults: {}, hide: false };

            if (Array.isArray(message.content)) {
                let hasOnlyToolResults = true;
                let hasTextContent = false;

                for (let j = 0; j < message.content.length; j++) {
                    const block = message.content[j];

                    if (block.type === "tool_use" && "id" in block) {
                        const toolUse = block as ToolUseBlockType;
                        pendingToolUses[toolUse.id] = { messageIndex: i, toolIndex: j };
                        hasOnlyToolResults = false;
                    } else if (block.type === "tool_result" && "tool_use_id" in block) {
                        const toolResult = block as ToolResultBlockParam;
                        const toolUseId = toolResult.tool_use_id;

                        if (pendingToolUses[toolUseId]) {
                            const { messageIndex } = pendingToolUses[toolUseId];
                            if (!enhancedMessages[messageIndex]) {
                                enhancedMessages[messageIndex] = { ...messages[messageIndex], toolResults: {}, hide: false };
                            }
                            enhancedMessages[messageIndex].toolResults![toolUseId] = toolResult;
                            delete pendingToolUses[toolUseId];
                        }
                    } else if (block.type === "text") {
                        hasTextContent = true;
                        hasOnlyToolResults = false;
                    } else {
                        hasOnlyToolResults = false;
                    }
                }

                if (hasOnlyToolResults && !hasTextContent) {
                    enhancedMessage.hide = true;
                }
            }

            enhancedMessages[i] = enhancedMessage;
        }

        return enhancedMessages;
    }

    /**
     * Detects Claude Code compaction: a single-pair conversation whose message
     * list is two longer than an earlier thread with matching tail messages.
     */
    private detectAndMergeCompactConversations(conversations: SimpleConversation[]): SimpleConversation[] {
        if (conversations.length <= 1) return conversations;

        const sortedConversations = [...conversations].sort(
            (a, b) => new Date(a.metadata.startTime).getTime() - new Date(b.metadata.startTime).getTime(),
        );

        const usedConversations = new Set<number>();
        const mergedConversations: SimpleConversation[] = [];

        for (let i = 0; i < sortedConversations.length; i++) {
            const currentConv = sortedConversations[i];

            if (usedConversations.has(i)) continue;

            if (currentConv.allPairs.length === 1 && currentConv.messages.length > 2) {
                let originalConv: SimpleConversation | null = null;
                let originalIndex = -1;

                for (let j = 0; j < sortedConversations.length; j++) {
                    if (j === i || usedConversations.has(j)) continue;

                    const otherConv = sortedConversations[j];

                    if (otherConv.messages.length === currentConv.messages.length - 2) {
                        let messagesMatch = true;
                        for (let k = 1; k < otherConv.messages.length; k++) {
                            if (!this.messagesRoughlyEqual(otherConv.messages[k], currentConv.messages[k])) {
                                messagesMatch = false;
                                break;
                            }
                        }

                        if (messagesMatch) {
                            originalConv = otherConv;
                            originalIndex = j;
                            break;
                        }
                    }
                }

                if (originalConv) {
                    const mergedConv = this.mergeCompactConversation(originalConv, currentConv);
                    mergedConversations.push(mergedConv);
                    usedConversations.add(i);
                    usedConversations.add(originalIndex);
                } else {
                    currentConv.compacted = true;
                    mergedConversations.push(currentConv);
                    usedConversations.add(i);
                }
            } else {
                mergedConversations.push(currentConv);
                usedConversations.add(i);
            }
        }

        for (let i = 0; i < sortedConversations.length; i++) {
            if (!usedConversations.has(i)) {
                mergedConversations.push(sortedConversations[i]);
            }
        }

        return mergedConversations.sort(
            (a, b) => new Date(a.metadata.startTime).getTime() - new Date(b.metadata.startTime).getTime(),
        );
    }

    /**
     * Combines pre- and post-compaction threads, restoring the original first
     * user message while keeping the compacted response and pair list.
     */
    private mergeCompactConversation(
        originalConv: SimpleConversation,
        compactConv: SimpleConversation,
    ): SimpleConversation {
        const originalMessages = originalConv.messages || [];
        const compactMessages = compactConv.messages || [];

        const mergedMessages = [...compactMessages];
        if (originalMessages.length > 0 && mergedMessages.length > 0) {
            mergedMessages[0] = originalMessages[0];
        }

        const allPairs = [...originalConv.allPairs, ...compactConv.allPairs].sort(
            (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
        );

        const allModels = new Set([...originalConv.models, ...compactConv.models]);
        const startTime = allPairs[0].timestamp;
        const endTime = allPairs[allPairs.length - 1].timestamp;
        const apiFormatDisplay = formatApiFormatsDisplay(
            allPairs.map((pair) => pair.apiFormat || "unknown"),
        );

        return {
            id: compactConv.id,
            models: allModels,
            system: originalConv.system,
            messages: mergedMessages,
            response: compactConv.response,
            allPairs: allPairs,
            finalPair: compactConv.finalPair,
            compacted: true,
            apiFormatDisplay,
            metadata: {
                startTime: startTime,
                endTime: endTime,
                totalPairs: allPairs.length,
                inputTokens: (originalConv.metadata.inputTokens || 0) + (compactConv.metadata.inputTokens || 0),
                outputTokens: (originalConv.metadata.outputTokens || 0) + (compactConv.metadata.outputTokens || 0),
                totalTokens: (originalConv.metadata.totalTokens || 0) + (compactConv.metadata.totalTokens || 0),
            },
        };
    }

    /**
     * Loose equality check for compaction pairing — compares role and content shape only.
     */
    private messagesRoughlyEqual(msg1: MessageParam, msg2: MessageParam): boolean {
        if (msg1.role !== msg2.role) return false;

        const content1 = msg1.content;
        const content2 = msg2.content;

        if (typeof content1 !== typeof content2) return false;
        if (Array.isArray(content1) !== Array.isArray(content2)) return false;

        return true;
    }

    /**
     * Strips volatile substrings from the first message so threading keys stay
     * stable across retries (timestamps, IDE open events, system reminders).
     */
    private normalizeMessageForGrouping(message: MessageParam): MessageParam {
        if (!message || !message.content) return message;

        let normalizedContent: string | ContentBlockParam[];

        if (Array.isArray(message.content)) {
            normalizedContent = message.content.map((block) => {
                if (block.type === "text" && "text" in block) {
                    let text = block.text;
                    text = text.replace(/Generated \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/g, "Generated [TIMESTAMP]");
                    text = text.replace(/The user opened the file [^\s]+ in the IDE\./g, "The user opened file in IDE.");
                    text = text.replace(/<system-reminder>.*?<\/system-reminder>/gs, "[SYSTEM-REMINDER]");
                    text = text.replace(/<EXTREMELY_IMPORTANT>.*?<\/EXTREMELY_IMPORTANT>/gs, "[EXTREMELY-IMPORTANT]");
                    return { type: "text", text: text };
                }
                return block;
            });
        } else {
            normalizedContent = message.content;
        }

        return {
            role: message.role,
            content: normalizedContent,
        };
    }

    /**
     * Simple string hash for conversation grouping keys (not cryptographic).
     */
    private hashString(str: string): string {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = (hash << 5) - hash + char;
            hash = hash & hash;
        }
        return Math.abs(hash).toString();
    }
}
