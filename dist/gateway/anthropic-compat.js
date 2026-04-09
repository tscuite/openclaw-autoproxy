import { Transform } from "node:stream";
function isRecord(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function parsePathnameAndSearch(requestPath) {
    try {
        const parsed = new URL(requestPath, "http://localhost");
        return {
            pathname: parsed.pathname,
            search: parsed.search,
        };
    }
    catch {
        const [pathnamePart, ...searchParts] = requestPath.split("?");
        return {
            pathname: pathnamePart || "/",
            search: searchParts.length > 0 ? `?${searchParts.join("?")}` : "",
        };
    }
}
function isAnthropicMessagesPath(pathname) {
    return pathname === "/v1/messages";
}
function isNativeAnthropicMessagesUpstream(upstreamUrl) {
    try {
        const pathname = new URL(upstreamUrl).pathname.replace(/\/+$/, "");
        return pathname.endsWith("/v1/messages");
    }
    catch {
        return false;
    }
}
function stringifyToolResultContent(content) {
    if (typeof content === "string") {
        return content;
    }
    if (Array.isArray(content)) {
        const textParts = content
            .filter((item) => isRecord(item) && item.type === "text" && typeof item.text === "string")
            .map((item) => String(item.text));
        if (textParts.length === content.length) {
            return textParts.join("\n\n");
        }
    }
    try {
        return JSON.stringify(content ?? "");
    }
    catch {
        return String(content ?? "");
    }
}
function normalizeSystemPrompt(system) {
    if (system === undefined || system === null) {
        return { value: null };
    }
    if (typeof system === "string") {
        return { value: system };
    }
    if (!Array.isArray(system)) {
        return {
            value: null,
            error: 'Anthropic request field "system" must be a string or an array of text blocks.',
        };
    }
    const textParts = [];
    for (const block of system) {
        if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") {
            return {
                value: null,
                error: 'Anthropic request field "system" only supports text blocks when routed to an OpenAI-style upstream.',
            };
        }
        textParts.push(block.text);
    }
    return { value: textParts.join("\n\n") };
}
function appendUserContentBlocks(content, target) {
    if (typeof content === "string") {
        target.push({
            role: "user",
            content,
        });
        return null;
    }
    if (!Array.isArray(content)) {
        return 'Anthropic user message content must be a string or an array of content blocks.';
    }
    const pendingText = [];
    const flushText = () => {
        if (pendingText.length === 0) {
            return;
        }
        target.push({
            role: "user",
            content: pendingText.join("\n\n"),
        });
        pendingText.length = 0;
    };
    for (const block of content) {
        if (!isRecord(block) || typeof block.type !== "string") {
            return 'Anthropic user message content contains an invalid block.';
        }
        if (block.type === "text") {
            if (typeof block.text !== "string") {
                return 'Anthropic text content blocks must include a string "text" field.';
            }
            pendingText.push(block.text);
            continue;
        }
        if (block.type === "tool_result") {
            const toolUseId = typeof block.tool_use_id === "string" ? block.tool_use_id.trim() : "";
            if (!toolUseId) {
                return 'Anthropic tool_result blocks must include a non-empty "tool_use_id" field.';
            }
            flushText();
            target.push({
                role: "tool",
                tool_call_id: toolUseId,
                content: stringifyToolResultContent(block.content),
            });
            continue;
        }
        return `Anthropic user content block type "${block.type}" is not supported for OpenAI-style upstream routes.`;
    }
    flushText();
    return null;
}
function appendAssistantContentBlocks(content, target) {
    if (typeof content === "string") {
        target.push({
            role: "assistant",
            content,
        });
        return null;
    }
    if (!Array.isArray(content)) {
        return 'Anthropic assistant message content must be a string or an array of content blocks.';
    }
    const textParts = [];
    const toolCalls = [];
    for (const block of content) {
        if (!isRecord(block) || typeof block.type !== "string") {
            return 'Anthropic assistant message content contains an invalid block.';
        }
        if (block.type === "text") {
            if (typeof block.text !== "string") {
                return 'Anthropic text content blocks must include a string "text" field.';
            }
            textParts.push(block.text);
            continue;
        }
        if (block.type === "tool_use") {
            const toolId = typeof block.id === "string" && block.id.trim()
                ? block.id.trim()
                : `toolu_${Date.now()}_${toolCalls.length}`;
            const toolName = typeof block.name === "string" ? block.name.trim() : "";
            if (!toolName) {
                return 'Anthropic tool_use blocks must include a non-empty "name" field.';
            }
            toolCalls.push({
                id: toolId,
                type: "function",
                function: {
                    name: toolName,
                    arguments: JSON.stringify(block.input ?? {}),
                },
            });
            continue;
        }
        if (block.type === "thinking" || block.type === "redacted_thinking") {
            continue;
        }
        return `Anthropic assistant content block type "${block.type}" is not supported for OpenAI-style upstream routes.`;
    }
    if (textParts.length === 0 && toolCalls.length === 0) {
        target.push({
            role: "assistant",
            content: "",
        });
        return null;
    }
    target.push({
        role: "assistant",
        content: textParts.length > 0 ? textParts.join("\n\n") : null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    });
    return null;
}
function convertAnthropicTools(tools) {
    if (tools === undefined) {
        return { value: undefined };
    }
    if (!Array.isArray(tools)) {
        return { error: 'Anthropic request field "tools" must be an array.' };
    }
    const converted = [];
    for (const tool of tools) {
        if (!isRecord(tool)) {
            return { error: 'Anthropic request field "tools" contains an invalid entry.' };
        }
        const name = typeof tool.name === "string" ? tool.name.trim() : "";
        if (!name) {
            return { error: 'Anthropic tool entries must include a non-empty "name" field.' };
        }
        const inputSchema = tool.input_schema;
        if (!isRecord(inputSchema)) {
            return {
                error: 'Anthropic tool entries must include an object "input_schema" field when routed to an OpenAI-style upstream.',
            };
        }
        const functionDefinition = {
            name,
            parameters: inputSchema,
        };
        if (typeof tool.description === "string" && tool.description.trim()) {
            functionDefinition.description = tool.description;
        }
        converted.push({
            type: "function",
            function: functionDefinition,
        });
    }
    return { value: converted };
}
function convertAnthropicToolChoice(toolChoice) {
    if (toolChoice === undefined) {
        return { value: undefined };
    }
    if (typeof toolChoice === "string") {
        if (toolChoice === "auto" || toolChoice === "none" || toolChoice === "required") {
            return { value: toolChoice };
        }
        return { error: `Unsupported Anthropic tool choice string "${toolChoice}".` };
    }
    if (!isRecord(toolChoice) || typeof toolChoice.type !== "string") {
        return { error: 'Anthropic request field "tool_choice" must be a string or an object with a "type" field.' };
    }
    if (toolChoice.type === "auto") {
        return { value: "auto" };
    }
    if (toolChoice.type === "any") {
        return { value: "required" };
    }
    if (toolChoice.type === "none") {
        return { value: "none" };
    }
    if (toolChoice.type === "tool") {
        const toolName = typeof toolChoice.name === "string" ? toolChoice.name.trim() : "";
        if (!toolName) {
            return { error: 'Anthropic tool_choice.type="tool" requires a non-empty "name" field.' };
        }
        return {
            value: {
                type: "function",
                function: {
                    name: toolName,
                },
            },
        };
    }
    return { error: `Unsupported Anthropic tool choice type "${toolChoice.type}".` };
}
function convertAnthropicMessagesRequest(body) {
    if (typeof body.model !== "string" || !body.model.trim()) {
        return { error: 'Anthropic request field "model" is required.' };
    }
    if (!Array.isArray(body.messages)) {
        return { error: 'Anthropic request field "messages" must be an array.' };
    }
    const systemPrompt = normalizeSystemPrompt(body.system);
    if (systemPrompt.error) {
        return { error: systemPrompt.error };
    }
    const messages = [];
    if (systemPrompt.value) {
        messages.push({
            role: "system",
            content: systemPrompt.value,
        });
    }
    for (const message of body.messages) {
        if (!isRecord(message) || typeof message.role !== "string") {
            return { error: 'Anthropic request field "messages" contains an invalid entry.' };
        }
        if (message.role === "user") {
            const error = appendUserContentBlocks(message.content, messages);
            if (error) {
                return { error };
            }
            continue;
        }
        if (message.role === "assistant") {
            const error = appendAssistantContentBlocks(message.content, messages);
            if (error) {
                return { error };
            }
            continue;
        }
        return { error: `Anthropic message role "${message.role}" is not supported.` };
    }
    const tools = convertAnthropicTools(body.tools);
    if (tools.error) {
        return { error: tools.error };
    }
    const toolChoice = convertAnthropicToolChoice(body.tool_choice);
    if (toolChoice.error) {
        return { error: toolChoice.error };
    }
    const converted = {
        model: body.model,
        messages,
    };
    if (typeof body.max_tokens === "number") {
        converted.max_tokens = body.max_tokens;
    }
    if (typeof body.temperature === "number") {
        converted.temperature = body.temperature;
    }
    if (typeof body.top_p === "number") {
        converted.top_p = body.top_p;
    }
    if (typeof body.stream === "boolean") {
        converted.stream = body.stream;
    }
    if (Array.isArray(body.stop_sequences)) {
        const stop = body.stop_sequences.filter((item) => typeof item === "string");
        if (stop.length > 0) {
            converted.stop = stop;
        }
    }
    if (tools.value && tools.value.length > 0) {
        converted.tools = tools.value;
    }
    if (toolChoice.value !== undefined) {
        converted.tool_choice = toolChoice.value;
    }
    return { value: converted };
}
function extractOpenAiTextContent(content) {
    if (typeof content === "string") {
        return content;
    }
    if (!Array.isArray(content)) {
        return null;
    }
    const textParts = [];
    for (const item of content) {
        if (typeof item === "string") {
            textParts.push(item);
            continue;
        }
        if (isRecord(item) && item.type === "text" && typeof item.text === "string") {
            textParts.push(item.text);
        }
    }
    return textParts.join("\n\n");
}
function parseOpenAiToolArguments(argumentsValue) {
    if (typeof argumentsValue !== "string") {
        return isRecord(argumentsValue) || Array.isArray(argumentsValue) ? argumentsValue : {};
    }
    try {
        return JSON.parse(argumentsValue);
    }
    catch {
        return {
            _raw: argumentsValue,
        };
    }
}
function mapOpenAiFinishReason(finishReason, hasToolUse) {
    if (finishReason === "tool_calls" || hasToolUse) {
        return "tool_use";
    }
    if (finishReason === "length") {
        return "max_tokens";
    }
    return "end_turn";
}
function parseUsageValue(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
function extractErrorMessage(payload, fallbackStatus) {
    if (isRecord(payload)) {
        if (typeof payload.message === "string" && payload.message.trim()) {
            return payload.message;
        }
        if (isRecord(payload.error) && typeof payload.error.message === "string" && payload.error.message.trim()) {
            return payload.error.message;
        }
        if (Array.isArray(payload.detail)) {
            const details = payload.detail
                .map((item) => {
                if (typeof item === "string") {
                    return item;
                }
                if (!isRecord(item)) {
                    return null;
                }
                const location = Array.isArray(item.loc)
                    ? item.loc.map((part) => String(part)).join(".")
                    : null;
                const message = typeof item.msg === "string" ? item.msg : null;
                if (location && message) {
                    return `${location}: ${message}`;
                }
                if (message) {
                    return message;
                }
                return null;
            })
                .filter((item) => Boolean(item));
            if (details.length > 0) {
                return details.join("\n");
            }
        }
    }
    try {
        const serialized = JSON.stringify(payload);
        return serialized.length > 0
            ? serialized
            : `Upstream request failed with status ${fallbackStatus}.`;
    }
    catch {
        return `Upstream request failed with status ${fallbackStatus}.`;
    }
}
function formatSseEvent(event, payload) {
    return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}
function updateStreamUsage(state, payload) {
    if (!isRecord(payload) || !isRecord(payload.usage)) {
        return;
    }
    const promptTokens = parseUsageValue(payload.usage.prompt_tokens);
    const completionTokens = parseUsageValue(payload.usage.completion_tokens);
    if (promptTokens > 0) {
        state.inputTokens = promptTokens;
    }
    if (completionTokens >= 0) {
        state.outputTokens = completionTokens;
    }
}
function updateMessageIdentity(state, payload, fallbackModel) {
    if (!isRecord(payload)) {
        return;
    }
    if (!state.messageId && typeof payload.id === "string" && payload.id.trim()) {
        state.messageId = payload.id;
    }
    if (!state.model && typeof payload.model === "string" && payload.model.trim()) {
        state.model = payload.model;
    }
    if (!state.model && fallbackModel) {
        state.model = fallbackModel;
    }
}
function ensureAnthropicMessageStart(state) {
    if (state.messageStarted) {
        return [];
    }
    state.messageStarted = true;
    return [
        formatSseEvent("message_start", {
            type: "message_start",
            message: {
                id: state.messageId ?? `msg_${Date.now()}`,
                type: "message",
                role: "assistant",
                model: state.model ?? "",
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: {
                    input_tokens: state.inputTokens,
                    output_tokens: 0,
                },
            },
        }),
    ];
}
function closeAnthropicTextBlock(state) {
    if (state.openTextBlockIndex === null) {
        return [];
    }
    const blockIndex = state.openTextBlockIndex;
    state.openTextBlockIndex = null;
    return [
        formatSseEvent("content_block_stop", {
            type: "content_block_stop",
            index: blockIndex,
        }),
    ];
}
function closeAnthropicToolBlocks(state) {
    const events = [];
    for (const block of [...state.toolBlocks.values()].sort((left, right) => left.blockIndex - right.blockIndex)) {
        if (!block.open) {
            continue;
        }
        block.open = false;
        events.push(formatSseEvent("content_block_stop", {
            type: "content_block_stop",
            index: block.blockIndex,
        }));
    }
    return events;
}
function ensureAnthropicTextBlock(state) {
    if (state.openTextBlockIndex !== null) {
        return {
            events: [],
            blockIndex: state.openTextBlockIndex,
        };
    }
    const blockIndex = state.nextBlockIndex;
    state.nextBlockIndex += 1;
    state.openTextBlockIndex = blockIndex;
    return {
        blockIndex,
        events: [
            formatSseEvent("content_block_start", {
                type: "content_block_start",
                index: blockIndex,
                content_block: {
                    type: "text",
                    text: "",
                },
            }),
        ],
    };
}
function ensureAnthropicToolBlock(state, toolIndex, toolCall) {
    let block = state.toolBlocks.get(toolIndex);
    const functionRecord = isRecord(toolCall.function) ? toolCall.function : {};
    const nextId = typeof toolCall.id === "string" && toolCall.id.trim()
        ? toolCall.id.trim()
        : block?.id ?? `toolu_${Date.now()}_${toolIndex}`;
    const nextName = typeof functionRecord.name === "string" && functionRecord.name.trim()
        ? functionRecord.name.trim()
        : block?.name ?? `tool_${toolIndex}`;
    if (!block) {
        block = {
            blockIndex: state.nextBlockIndex,
            id: nextId,
            name: nextName,
            open: false,
        };
        state.nextBlockIndex += 1;
        state.toolBlocks.set(toolIndex, block);
    }
    else {
        block.id = nextId;
        block.name = nextName;
    }
    if (block.open) {
        return {
            events: [],
            blockIndex: block.blockIndex,
        };
    }
    block.open = true;
    state.sawToolUse = true;
    return {
        blockIndex: block.blockIndex,
        events: [
            formatSseEvent("content_block_start", {
                type: "content_block_start",
                index: block.blockIndex,
                content_block: {
                    type: "tool_use",
                    id: block.id,
                    name: block.name,
                    input: {},
                },
            }),
        ],
    };
}
function finalizeAnthropicMessageStream(state) {
    if (!state.messageStarted || state.messageStopped) {
        return [];
    }
    const events = [
        ...closeAnthropicTextBlock(state),
        ...closeAnthropicToolBlocks(state),
        formatSseEvent("message_delta", {
            type: "message_delta",
            delta: {
                stop_reason: state.stopReason ?? (state.sawToolUse ? "tool_use" : "end_turn"),
                stop_sequence: null,
            },
            usage: {
                output_tokens: state.outputTokens,
            },
        }),
        formatSseEvent("message_stop", {
            type: "message_stop",
        }),
    ];
    state.messageStopped = true;
    return events;
}
function parseSseData(frame) {
    const dataLines = frame
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart());
    if (dataLines.length === 0) {
        return null;
    }
    return dataLines.join("\n");
}
function transformOpenAiStreamPayloadToAnthropicEvents(params) {
    const { payload, state, fallbackModel } = params;
    updateStreamUsage(state, payload);
    updateMessageIdentity(state, payload, fallbackModel);
    const events = ensureAnthropicMessageStart(state);
    if (!isRecord(payload) || !Array.isArray(payload.choices)) {
        return events;
    }
    for (const choice of payload.choices) {
        if (!isRecord(choice) || !isRecord(choice.delta)) {
            continue;
        }
        const delta = choice.delta;
        if (typeof delta.content === "string" && delta.content.length > 0) {
            events.push(...closeAnthropicToolBlocks(state));
            const textBlock = ensureAnthropicTextBlock(state);
            events.push(...textBlock.events);
            events.push(formatSseEvent("content_block_delta", {
                type: "content_block_delta",
                index: textBlock.blockIndex,
                delta: {
                    type: "text_delta",
                    text: delta.content,
                },
            }));
        }
        if (Array.isArray(delta.tool_calls)) {
            events.push(...closeAnthropicTextBlock(state));
            for (const [fallbackIndex, entry] of delta.tool_calls.entries()) {
                if (!isRecord(entry)) {
                    continue;
                }
                const toolIndex = typeof entry.index === "number" ? entry.index : fallbackIndex;
                const toolBlock = ensureAnthropicToolBlock(state, toolIndex, entry);
                events.push(...toolBlock.events);
                const functionRecord = isRecord(entry.function) ? entry.function : {};
                const partialJson = typeof functionRecord.arguments === "string" ? functionRecord.arguments : "";
                if (partialJson.length > 0) {
                    events.push(formatSseEvent("content_block_delta", {
                        type: "content_block_delta",
                        index: toolBlock.blockIndex,
                        delta: {
                            type: "input_json_delta",
                            partial_json: partialJson,
                        },
                    }));
                }
            }
        }
        if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
            state.stopReason = mapOpenAiFinishReason(choice.finish_reason, state.sawToolUse);
            events.push(...closeAnthropicTextBlock(state));
            events.push(...closeAnthropicToolBlocks(state));
        }
    }
    return events;
}
export function createAnthropicMessagesEventStreamTransformer(fallbackModel) {
    const state = {
        inputTokens: 0,
        messageId: null,
        messageStarted: false,
        messageStopped: false,
        model: fallbackModel,
        nextBlockIndex: 0,
        openTextBlockIndex: null,
        outputTokens: 0,
        sawToolUse: false,
        stopReason: null,
        toolBlocks: new Map(),
    };
    let buffer = "";
    return new Transform({
        transform(chunk, _encoding, callback) {
            try {
                buffer += chunk.toString("utf8").replace(/\r\n/g, "\n");
                while (true) {
                    const delimiterIndex = buffer.indexOf("\n\n");
                    if (delimiterIndex === -1) {
                        break;
                    }
                    const frame = buffer.slice(0, delimiterIndex);
                    buffer = buffer.slice(delimiterIndex + 2);
                    const data = parseSseData(frame);
                    if (!data) {
                        continue;
                    }
                    if (data === "[DONE]") {
                        this.push(finalizeAnthropicMessageStream(state).join(""));
                        continue;
                    }
                    try {
                        const payload = JSON.parse(data);
                        const events = transformOpenAiStreamPayloadToAnthropicEvents({
                            fallbackModel,
                            payload,
                            state,
                        });
                        if (events.length > 0) {
                            this.push(events.join(""));
                        }
                    }
                    catch {
                        // Ignore malformed SSE payload chunks and continue streaming.
                    }
                }
                callback();
            }
            catch (error) {
                callback(error);
            }
        },
        flush(callback) {
            try {
                this.push(finalizeAnthropicMessageStream(state).join(""));
                callback();
            }
            catch (error) {
                callback(error);
            }
        },
    });
}
export function maybeTransformAnthropicMessagesRequest(params) {
    const { pathname, search } = parsePathnameAndSearch(params.requestPath);
    if (!isAnthropicMessagesPath(pathname)) {
        return {
            requestPath: params.requestPath,
            body: params.body,
            responseFormat: null,
        };
    }
    if (isNativeAnthropicMessagesUpstream(params.upstreamUrl)) {
        return {
            requestPath: params.requestPath,
            body: params.body,
            responseFormat: null,
        };
    }
    const converted = convertAnthropicMessagesRequest(params.body);
    if (converted.error || !converted.value) {
        return {
            requestPath: params.requestPath,
            body: params.body,
            responseFormat: null,
            error: converted.error ??
                'Gateway failed to translate the Anthropic request for the selected OpenAI-style upstream route.',
        };
    }
    return {
        requestPath: `/v1/chat/completions${search}`,
        body: converted.value,
        responseFormat: "anthropic-messages",
    };
}
export function transformOpenAiChatCompletionToAnthropicMessage(payload, fallbackModel) {
    if (!isRecord(payload) || !Array.isArray(payload.choices) || payload.choices.length === 0) {
        return { error: 'Upstream response is not a valid OpenAI chat completion payload.' };
    }
    const firstChoice = payload.choices[0];
    if (!isRecord(firstChoice) || !isRecord(firstChoice.message)) {
        return { error: 'Upstream response does not include a chat completion message.' };
    }
    const message = firstChoice.message;
    const content = [];
    const text = extractOpenAiTextContent(message.content);
    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    if (typeof text === "string" && text.length > 0) {
        content.push({
            type: "text",
            text,
        });
    }
    for (const toolCall of toolCalls) {
        if (!isRecord(toolCall) || !isRecord(toolCall.function)) {
            continue;
        }
        const toolId = typeof toolCall.id === "string" && toolCall.id.trim()
            ? toolCall.id.trim()
            : `toolu_${Date.now()}_${content.length}`;
        const toolName = typeof toolCall.function.name === "string" ? toolCall.function.name.trim() : "";
        if (!toolName) {
            continue;
        }
        content.push({
            type: "tool_use",
            id: toolId,
            name: toolName,
            input: parseOpenAiToolArguments(toolCall.function.arguments),
        });
    }
    if (content.length === 0) {
        content.push({
            type: "text",
            text: text ?? "",
        });
    }
    const usage = isRecord(payload.usage) ? payload.usage : {};
    const resolvedModel = typeof payload.model === "string" && payload.model.trim()
        ? payload.model
        : fallbackModel ?? "";
    return {
        value: {
            id: typeof payload.id === "string" && payload.id.trim()
                ? payload.id
                : `msg_${Date.now()}`,
            type: "message",
            role: "assistant",
            content,
            model: resolvedModel,
            stop_reason: mapOpenAiFinishReason(firstChoice.finish_reason, toolCalls.length > 0),
            stop_sequence: null,
            usage: {
                input_tokens: parseUsageValue(usage.prompt_tokens),
                output_tokens: parseUsageValue(usage.completion_tokens),
            },
        },
    };
}
export function transformUpstreamErrorToAnthropicError(payload, statusCode) {
    return {
        type: "error",
        error: {
            type: statusCode >= 500 ? "api_error" : "invalid_request_error",
            message: extractErrorMessage(payload, statusCode),
        },
    };
}
