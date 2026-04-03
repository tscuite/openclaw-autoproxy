import { PassThrough, Readable } from "node:stream";
import { config } from "./config.js";
const HOP_BY_HOP_HEADERS = new Set([
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
]);
const MAX_REQUEST_BODY_BYTES = 50 * 1024 * 1024;
const AUTO_MODEL = "auto";
let autoModelCursor = 0;
function logProxyModelRoute(params) {
    console.log(`[gateway] requested_model=${params.requestedModel ?? "-"} used_model=${params.usedModel ?? "-"} route=${params.routeName ?? "-"}`);
}
function resolveRouteNameForModel(modelId) {
    if (modelId && config.modelRouteMap[modelId]) {
        return config.modelRouteMap[modelId].routeName;
    }
    return config.modelRouteMap["*"]?.routeName ?? null;
}
function logProxyModelSwitch(params) {
    console.log(`[gateway] switch trigger_status=${params.triggerStatus} from_model=${params.fromModel ?? "-"} from_route=${params.fromRoute ?? "-"} to_model=${params.toModel ?? "-"} to_route=${params.toRoute ?? "-"}`);
}
function sendJson(response, statusCode, payload) {
    if (response.writableEnded) {
        return;
    }
    const body = JSON.stringify(payload);
    response.statusCode = statusCode;
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.setHeader("content-length", Buffer.byteLength(body));
    response.end(body);
}
function normalizeRequestPath(request) {
    const rawUrl = request.url ?? "/";
    try {
        const parsed = new URL(rawUrl, "http://localhost");
        return `${parsed.pathname}${parsed.search}`;
    }
    catch {
        return rawUrl.startsWith("/") ? rawUrl : `/${rawUrl}`;
    }
}
function rotateCandidates(candidates, startIndex) {
    if (candidates.length <= 1) {
        return [...candidates];
    }
    const normalizedStart = startIndex % candidates.length;
    return [
        ...candidates.slice(normalizedStart),
        ...candidates.slice(0, normalizedStart),
    ];
}
function buildAutoModelCandidates() {
    const routableModels = Object.keys(config.modelRouteMap).filter((modelName) => modelName !== "*" && modelName.toLowerCase() !== AUTO_MODEL);
    if (routableModels.length === 0) {
        return [];
    }
    const rotated = rotateCandidates(routableModels, autoModelCursor);
    autoModelCursor = (autoModelCursor + 1) % routableModels.length;
    return rotated;
}
function buildModelCandidates(requestedModel) {
    if (requestedModel.toLowerCase() === AUTO_MODEL) {
        return buildAutoModelCandidates();
    }
    // Non-auto requests are pinned to the exact model specified by client.
    return [requestedModel];
}
function buildRoutedUpstreamUrl(request, selectedRoute) {
    if (!selectedRoute) {
        return `${config.upstreamBaseUrl}${normalizeRequestPath(request)}`;
    }
    if (!selectedRoute.isBaseUrl) {
        return selectedRoute.url;
    }
    const routeBase = selectedRoute.url.replace(/\/+$/, "");
    const requestPath = normalizeRequestPath(request);
    if (routeBase.endsWith("/v1") && requestPath.startsWith("/v1")) {
        return `${routeBase}${requestPath.slice(3)}`;
    }
    return `${routeBase}${requestPath}`;
}
function resolveUpstreamTarget(request, modelId) {
    const modelRoute = modelId ? config.modelRouteMap[modelId] ?? null : null;
    const wildcardRoute = config.modelRouteMap["*"] ?? null;
    const selectedRoute = modelRoute ?? wildcardRoute;
    return {
        upstreamUrl: buildRoutedUpstreamUrl(request, selectedRoute),
        selectedRoute,
    };
}
function buildUpstreamHeaders(reqHeaders, bodyLength, selectedRoute) {
    const headers = new Headers();
    for (const [key, value] of Object.entries(reqHeaders)) {
        if (value === undefined) {
            continue;
        }
        const lowerKey = key.toLowerCase();
        if (HOP_BY_HOP_HEADERS.has(lowerKey) || lowerKey === "host" || lowerKey === "content-length") {
            continue;
        }
        headers.set(key, Array.isArray(value) ? value.join(",") : String(value));
    }
    if (selectedRoute?.headers) {
        for (const [key, value] of Object.entries(selectedRoute.headers)) {
            headers.set(key, value);
        }
    }
    if (selectedRoute?.apiKey) {
        const authHeader = selectedRoute.authHeader || "authorization";
        const authPrefix = selectedRoute.authPrefix ?? "Bearer ";
        if (!headers.has(authHeader)) {
            headers.set(authHeader, `${authPrefix}${selectedRoute.apiKey}`);
        }
    }
    else if (!headers.has("authorization") && config.upstreamApiKey) {
        headers.set("authorization", `Bearer ${config.upstreamApiKey}`);
    }
    if (typeof bodyLength === "number") {
        headers.set("content-length", String(bodyLength));
    }
    return headers;
}
function isJsonRequest(headers) {
    const contentTypeHeader = headers["content-type"];
    const contentType = Array.isArray(contentTypeHeader)
        ? contentTypeHeader.join(";").toLowerCase()
        : String(contentTypeHeader ?? "").toLowerCase();
    return contentType.includes("application/json");
}
function parseJsonBody(buffer, shouldParse) {
    if (!shouldParse || buffer.length === 0) {
        return { parsed: null, error: null };
    }
    try {
        const parsed = JSON.parse(buffer.toString("utf8"));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            return { parsed: parsed, error: null };
        }
        return { parsed: null, error: null };
    }
    catch {
        return { parsed: null, error: "Invalid JSON body." };
    }
}
function parseStatusLikeCode(value) {
    if (typeof value === "number" && Number.isInteger(value)) {
        return value >= 100 && value <= 9999 ? value : null;
    }
    if (typeof value === "string") {
        const trimmed = value.trim();
        if (!trimmed) {
            return null;
        }
        const parsed = Number.parseInt(trimmed, 10);
        return Number.isInteger(parsed) && parsed >= 100 && parsed <= 9999 ? parsed : null;
    }
    return null;
}
function extractRetryStatusFromJsonPayload(payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        return null;
    }
    const record = payload;
    const candidates = [record.status, record.code, record.errorCode];
    const nestedError = record.error;
    if (nestedError && typeof nestedError === "object" && !Array.isArray(nestedError)) {
        const nested = nestedError;
        candidates.push(nested.status, nested.code, nested.errorCode);
    }
    const nestedErrors = record.errors;
    if (Array.isArray(nestedErrors)) {
        for (const item of nestedErrors) {
            if (!item || typeof item !== "object" || Array.isArray(item)) {
                continue;
            }
            const nested = item;
            candidates.push(nested.status, nested.code, nested.errorCode);
        }
    }
    for (const candidate of candidates) {
        const parsed = parseStatusLikeCode(candidate);
        if (parsed !== null) {
            return parsed;
        }
    }
    return null;
}
async function detectRetryStatusFromBody(upstreamResponse, retryStatusCodes) {
    const contentType = (upstreamResponse.headers.get("content-type") ?? "").toLowerCase();
    if (!contentType.includes("application/json") || contentType.includes("text/event-stream")) {
        return null;
    }
    try {
        const raw = await upstreamResponse.clone().text();
        if (!raw.trim()) {
            return null;
        }
        const parsed = JSON.parse(raw);
        const statusFromPayload = extractRetryStatusFromJsonPayload(parsed);
        if (statusFromPayload !== null && retryStatusCodes.has(statusFromPayload)) {
            return statusFromPayload;
        }
    }
    catch {
        // Ignore probe errors and continue with normal response handling.
    }
    return null;
}
function copyResponseHeaders(upstreamResponse, response) {
    for (const [key, value] of upstreamResponse.headers.entries()) {
        if (HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
            continue;
        }
        response.setHeader(key, value);
    }
}
async function fetchWithTimeout(url, options, timeoutMs) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    }
    finally {
        clearTimeout(timeoutId);
    }
}
async function disposeBody(response) {
    if (!response.body) {
        return;
    }
    try {
        await response.body.cancel();
    }
    catch {
        // Body cancellation is best effort.
    }
}
function createSsePrefixedStream(source, notice) {
    const passthrough = new PassThrough();
    passthrough.write(`event: gateway_notice\ndata: ${JSON.stringify(notice)}\n\n`);
    source.on("error", () => {
        passthrough.end();
    });
    source.pipe(passthrough);
    return passthrough;
}
async function readRequestBody(request) {
    return await new Promise((resolve, reject) => {
        const chunks = [];
        let totalSize = 0;
        let settled = false;
        request.on("data", (chunk) => {
            if (settled) {
                return;
            }
            const normalizedChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            totalSize += normalizedChunk.length;
            if (totalSize > MAX_REQUEST_BODY_BYTES) {
                settled = true;
                request.destroy();
                reject(new Error(`Request body exceeds ${MAX_REQUEST_BODY_BYTES} bytes.`));
                return;
            }
            chunks.push(normalizedChunk);
        });
        request.on("end", () => {
            if (settled) {
                return;
            }
            settled = true;
            resolve(Buffer.concat(chunks));
        });
        request.on("aborted", () => {
            if (settled) {
                return;
            }
            settled = true;
            reject(new Error("Request was aborted by client."));
        });
        request.on("error", (error) => {
            if (settled) {
                return;
            }
            settled = true;
            reject(error);
        });
    });
}
export async function proxyRequest(request, response) {
    const method = (request.method ?? "GET").toUpperCase();
    const supportsBody = method !== "GET" && method !== "HEAD";
    let incomingBody = Buffer.alloc(0);
    if (supportsBody) {
        try {
            incomingBody = await readRequestBody(request);
        }
        catch (error) {
            const isBodyTooLarge = error instanceof Error &&
                error.message.includes("exceeds") &&
                error.message.includes("bytes");
            sendJson(response, isBodyTooLarge ? 413 : 400, {
                error: {
                    message: "Failed to read request body.",
                    detail: error instanceof Error ? error.message : "Unknown error",
                },
            });
            return;
        }
    }
    const wantsJson = isJsonRequest(request.headers);
    const { parsed: parsedJsonBody, error: parseError } = parseJsonBody(incomingBody, wantsJson);
    if (parseError) {
        sendJson(response, 400, {
            error: {
                message: parseError,
            },
        });
        return;
    }
    const requestedModel = parsedJsonBody &&
        typeof parsedJsonBody.model === "string" &&
        parsedJsonBody.model.trim()
        ? parsedJsonBody.model.trim()
        : null;
    const modelCandidates = requestedModel
        ? buildModelCandidates(requestedModel)
        : [null];
    if (requestedModel?.toLowerCase() === AUTO_MODEL && modelCandidates.length === 0) {
        sendJson(response, 400, {
            error: {
                message: 'No auto model candidates configured. Set routes, GLOBAL_FALLBACK_MODELS, or MODEL_FALLBACK_MAP["auto"].',
            },
        });
        return;
    }
    let lastError = null;
    let lastAttemptRouteName = null;
    let switchNotice = null;
    for (let attemptIndex = 0; attemptIndex < modelCandidates.length; attemptIndex += 1) {
        const modelId = modelCandidates[attemptIndex];
        let bodyBuffer = supportsBody && incomingBody.length > 0 ? incomingBody : undefined;
        if (supportsBody && parsedJsonBody && modelId) {
            bodyBuffer = Buffer.from(JSON.stringify({
                ...parsedJsonBody,
                model: modelId,
            }), "utf8");
        }
        const { upstreamUrl, selectedRoute } = resolveUpstreamTarget(request, modelId);
        lastAttemptRouteName = selectedRoute?.routeName ?? null;
        const requestBody = bodyBuffer ? new Uint8Array(bodyBuffer) : undefined;
        const headers = buildUpstreamHeaders(request.headers, bodyBuffer ? bodyBuffer.length : undefined, selectedRoute);
        try {
            const upstreamResponse = await fetchWithTimeout(upstreamUrl, {
                method,
                headers,
                body: requestBody,
            }, config.timeoutMs);
            const contentType = (upstreamResponse.headers.get("content-type") ?? "").toLowerCase();
            const isEventStream = contentType.includes("text/event-stream");
            const isJsonResponse = contentType.includes("application/json");
            const hasNextCandidate = attemptIndex < modelCandidates.length - 1;
            const httpRetryStatus = config.retryStatusCodes.has(upstreamResponse.status)
                ? upstreamResponse.status
                : null;
            const bodyRetryStatus = !httpRetryStatus && hasNextCandidate
                ? await detectRetryStatusFromBody(upstreamResponse, config.retryStatusCodes)
                : null;
            const retryTriggerStatus = httpRetryStatus ?? bodyRetryStatus;
            const canRetry = retryTriggerStatus !== null && hasNextCandidate;
            if (canRetry) {
                const nextModel = modelCandidates[attemptIndex + 1];
                const triggerStatus = retryTriggerStatus ?? upstreamResponse.status;
                const nextRouteName = resolveRouteNameForModel(nextModel);
                logProxyModelSwitch({
                    triggerStatus,
                    fromModel: modelId,
                    toModel: nextModel,
                    fromRoute: selectedRoute?.routeName ?? null,
                    toRoute: nextRouteName,
                });
                if (modelId && nextModel && nextModel !== modelId) {
                    switchNotice = {
                        trigger_status: triggerStatus,
                        from_model: modelId,
                        from_route: selectedRoute?.routeName ?? null,
                        to_model: nextModel,
                        to_route: nextRouteName,
                    };
                }
                await disposeBody(upstreamResponse);
                continue;
            }
            const attemptCount = attemptIndex + 1;
            const effectiveSwitchNotice = switchNotice;
            copyResponseHeaders(upstreamResponse, response);
            response.setHeader("x-gateway-attempt-count", String(attemptCount));
            if (modelId) {
                response.setHeader("x-gateway-model-used", modelId);
            }
            if (effectiveSwitchNotice) {
                response.setHeader("x-gateway-switched", "1");
            }
            logProxyModelRoute({
                requestedModel,
                usedModel: modelId,
                routeName: selectedRoute?.routeName ?? null,
            });
            response.statusCode = upstreamResponse.status;
            if (!upstreamResponse.body) {
                response.end();
                return;
            }
            if (effectiveSwitchNotice && isJsonResponse && !isEventStream) {
                const rawText = await upstreamResponse.text();
                response.removeHeader("content-length");
                try {
                    const parsed = JSON.parse(rawText);
                    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                        parsed.gateway_notice = effectiveSwitchNotice;
                        response.end(JSON.stringify(parsed));
                        return;
                    }
                }
                catch {
                    // Keep original response body when JSON mutation is not possible.
                }
                response.end(rawText);
                return;
            }
            const nodeStream = Readable.fromWeb(upstreamResponse.body);
            if (effectiveSwitchNotice && isEventStream) {
                response.removeHeader("content-length");
                createSsePrefixedStream(nodeStream, effectiveSwitchNotice).pipe(response);
                return;
            }
            nodeStream.on("error", () => {
                if (!response.writableEnded) {
                    response.destroy();
                }
            });
            nodeStream.pipe(response);
            return;
        }
        catch (error) {
            lastError = error;
            if (attemptIndex < modelCandidates.length - 1) {
                continue;
            }
        }
    }
    const timeoutLike = lastError &&
        typeof lastError === "object" &&
        "name" in lastError &&
        lastError.name === "AbortError";
    const errorStatusCode = timeoutLike ? 504 : 502;
    const lastTriedModel = modelCandidates[modelCandidates.length - 1] ?? null;
    logProxyModelRoute({
        requestedModel,
        usedModel: lastTriedModel,
        routeName: lastAttemptRouteName,
    });
    sendJson(response, errorStatusCode, {
        error: {
            message: "Gateway failed to reach upstream provider.",
            detail: lastError instanceof Error ? lastError.message : "Unknown error",
        },
    });
}
