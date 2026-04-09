import { type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import { PassThrough, Readable } from "node:stream";
import { Agent } from "undici";
import {
  createAnthropicMessagesEventStreamTransformer,
  maybeTransformAnthropicMessagesRequest,
  transformOpenAiChatCompletionToAnthropicMessage,
  transformUpstreamErrorToAnthropicError,
} from "./anthropic-compat.js";
import { config, type ModelRouteConfig } from "./config.js";
import { recordModelLoadSample } from "./model-load-metrics.js";

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

interface ParsedJsonBody {
  model?: string;
  [key: string]: unknown;
}

interface GatewaySwitchNotice {
  trigger_status: number;
  from_model: string;
  from_route: string | null;
  to_model: string;
  to_route: string | null;
}

type GatewayProtocol = "openai" | "anthropic";

const AUTO_MODEL = "auto";
let autoModelCursor = 0;

const upstreamAgent = new Agent({
  connections: config.upstreamMaxConnections,
  pipelining: 1,
  keepAliveTimeout: config.upstreamKeepAliveTimeoutMs,
  keepAliveMaxTimeout: config.upstreamKeepAliveMaxTimeoutMs,
});

interface RequestInitWithDispatcher extends RequestInit {
  dispatcher?: Agent;
}

const fetchWithDispatcher = fetch as unknown as (
  input: string,
  init?: RequestInitWithDispatcher,
) => Promise<Response>;

function formatGatewayLogValue(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") {
    return "-";
  }

  const normalized = String(value);
  return /\s|"/.test(normalized) ? JSON.stringify(normalized) : normalized;
}

function buildGatewayLogLine(
  protocol: GatewayProtocol,
  event: string,
  fields: Record<string, string | number | null | undefined>,
): string {
  const parts = [
    "[gateway]",
    `protocol=${formatGatewayLogValue(protocol)}`,
    `event=${formatGatewayLogValue(event)}`,
  ];

  for (const [key, value] of Object.entries(fields)) {
    parts.push(`${key}=${formatGatewayLogValue(value)}`);
  }

  return parts.join(" ");
}

function logProxyModelRoute(params: {
  protocol: GatewayProtocol;
  requestedModel: string | null;
  usedModel: string | null;
  routeName: string | null;
}): void {
  console.log(
    buildGatewayLogLine(params.protocol, "routed", {
      requested_model: params.requestedModel,
      used_model: params.usedModel,
      route: params.routeName,
    }),
  );
}

function resolveRouteNameForModel(modelId: string | null): string | null {
  if (modelId && config.modelRouteMap[modelId]) {
    return config.modelRouteMap[modelId].routeName;
  }

  return config.modelRouteMap["*"]?.routeName ?? null;
}

function logProxyModelSwitch(params: {
  protocol: GatewayProtocol;
  triggerStatus: number;
  fromModel: string | null;
  toModel: string | null;
  fromRoute: string | null;
  toRoute: string | null;
}): void {
  console.log(
    buildGatewayLogLine(params.protocol, "switch", {
      trigger_status: params.triggerStatus,
      from_model: params.fromModel,
      from_route: params.fromRoute,
      to_model: params.toModel,
      to_route: params.toRoute,
    }),
  );
}

function resolveGatewayProtocolFromPath(requestPath: string): GatewayProtocol {
  const { pathname } = parsePathnameAndSearch(requestPath);

  if (
    pathname === "/anthropic" ||
    pathname.startsWith("/anthropic/") ||
    isAnthropicApiPath(pathname)
  ) {
    return "anthropic";
  }

  return "openai";
}

function resolveGatewayProtocol(request: IncomingMessage): GatewayProtocol {
  const rawUrl = request.url ?? "/";
  const normalizedRawUrl = rawUrl.startsWith("/") ? rawUrl : `/${rawUrl}`;
  return resolveGatewayProtocolFromPath(normalizedRawUrl);
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  if (response.writableEnded) {
    return;
  }

  const body = JSON.stringify(payload);
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("content-length", Buffer.byteLength(body));
  response.end(body);
}

function normalizeRequestPath(request: IncomingMessage): string {
  const rawUrl = request.url ?? "/";

  try {
    const parsed = new URL(rawUrl, "http://localhost");
    return normalizeGatewayRequestPath(`${parsed.pathname}${parsed.search}`);
  } catch {
    const normalizedRawUrl = rawUrl.startsWith("/") ? rawUrl : `/${rawUrl}`;
    return normalizeGatewayRequestPath(normalizedRawUrl);
  }
}

function normalizeGatewayRequestPath(requestPath: string): string {
  const { pathname, search } = parsePathnameAndSearch(requestPath);

  if (pathname === "/anthropic") {
    return `/v1${search}`;
  }

  if (pathname === "/anthropic/v1" || pathname.startsWith("/anthropic/v1/")) {
    return `${pathname.slice("/anthropic".length)}${search}`;
  }

  if (pathname.startsWith("/anthropic/")) {
    return `/v1${pathname.slice("/anthropic".length)}${search}`;
  }

  return `${pathname}${search}`;
}

function rotateCandidates(candidates: string[], startIndex: number): string[] {
  if (candidates.length <= 1) {
    return [...candidates];
  }

  const normalizedStart = startIndex % candidates.length;
  return [
    ...candidates.slice(normalizedStart),
    ...candidates.slice(0, normalizedStart),
  ];
}

function buildAutoModelCandidates(): string[] {
  const routableModels = Object.keys(config.modelRouteMap).filter(
    (modelName) => modelName !== "*" && modelName.toLowerCase() !== AUTO_MODEL,
  );

  if (routableModels.length === 0) {
    return [];
  }

  const rotated = rotateCandidates(routableModels, autoModelCursor);
  autoModelCursor = (autoModelCursor + 1) % routableModels.length;
  return rotated;
}

function buildModelCandidates(requestedModel: string): string[] {
  if (requestedModel.toLowerCase() === AUTO_MODEL) {
    return buildAutoModelCandidates();
  }

  // Non-auto requests are pinned to the exact model specified by client.
  return [requestedModel];
}

function parsePathnameAndSearch(requestPath: string): { pathname: string; search: string } {
  try {
    const parsed = new URL(requestPath, "http://localhost");
    return {
      pathname: parsed.pathname,
      search: parsed.search,
    };
  } catch {
    const [pathnamePart, ...searchParts] = requestPath.split("?");

    return {
      pathname: pathnamePart || "/",
      search: searchParts.length > 0 ? `?${searchParts.join("?")}` : "",
    };
  }
}

function isAnthropicApiPath(pathname: string): boolean {
  return (
    pathname === "/v1/messages" ||
    pathname.startsWith("/v1/messages/") ||
    pathname === "/v1/models" ||
    pathname === "/v1/complete"
  );
}

function rewriteFixedChatCompletionsRouteUrlForAnthropic(
  routeUrl: string,
  requestPath: string,
): string | null {
  const { pathname: requestPathname, search: requestSearch } = parsePathnameAndSearch(requestPath);

  if (!isAnthropicApiPath(requestPathname)) {
    return null;
  }

  let parsedRouteUrl: URL;

  try {
    parsedRouteUrl = new URL(routeUrl);
  } catch {
    return null;
  }

  const normalizedRoutePath = parsedRouteUrl.pathname.replace(/\/+$/, "");
  const fixedChatCompletionsSuffix = "/v1/chat/completions";

  if (!normalizedRoutePath.endsWith(fixedChatCompletionsSuffix)) {
    return null;
  }

  const routePrefixPath = normalizedRoutePath.slice(0, -fixedChatCompletionsSuffix.length);
  parsedRouteUrl.pathname = `${routePrefixPath}${requestPathname}`.replace(/\/{2,}/g, "/");
  parsedRouteUrl.search = requestSearch;

  return parsedRouteUrl.toString();
}

function buildRoutedUpstreamUrl(requestPath: string, selectedRoute: ModelRouteConfig | null): string {
  if (!selectedRoute) {
    return `${config.upstreamBaseUrl}${requestPath}`;
  }

  if (!selectedRoute.isBaseUrl) {
    // Backward-compatible Anthropic support when route URL is fixed to /v1/chat/completions.
    const anthropicCompatUrl = rewriteFixedChatCompletionsRouteUrlForAnthropic(
      selectedRoute.url,
      requestPath,
    );

    if (anthropicCompatUrl) {
      return anthropicCompatUrl;
    }

    return selectedRoute.url;
  }

  const routeBase = selectedRoute.url.replace(/\/+$/, "");

  if (routeBase.endsWith("/v1") && requestPath.startsWith("/v1")) {
    return `${routeBase}${requestPath.slice(3)}`;
  }

  return `${routeBase}${requestPath}`;
}

function resolveUpstreamTarget(
  requestPath: string,
  modelId: string | null,
): { upstreamUrl: string; selectedRoute: ModelRouteConfig | null } {
  const modelRoute = modelId ? config.modelRouteMap[modelId] ?? null : null;
  const wildcardRoute = config.modelRouteMap["*"] ?? null;
  const selectedRoute = modelRoute ?? wildcardRoute;

  return {
    upstreamUrl: buildRoutedUpstreamUrl(requestPath, selectedRoute),
    selectedRoute,
  };
}

async function logUpstreamErrorResponse(params: {
  protocol: GatewayProtocol;
  requestPath: string;
  upstreamUrl: string;
  routeName: string | null;
  modelId: string | null;
  response: Response;
}): Promise<void> {
  let detail = "-";

  try {
    const raw = await params.response.clone().text();
    const normalized = raw.replace(/\s+/g, " ").trim();

    if (normalized) {
      detail = normalized.slice(0, 2000);
    }
  } catch {
    detail = "<unavailable>";
  }

  console.error(
    buildGatewayLogLine(params.protocol, "upstream_error", {
      status: params.response.status,
      path: params.requestPath,
      route: params.routeName,
      model: params.modelId,
      upstream: params.upstreamUrl,
      detail,
    }),
  );
}

function buildUpstreamHeaders(
  reqHeaders: IncomingHttpHeaders,
  bodyLength: number | undefined,
  selectedRoute: ModelRouteConfig | null,
): Headers {
  const headers = new Headers();
  const selectedAuthHeader = selectedRoute?.authHeader || "authorization";
  const conflictingAuthHeaders = ["authorization", "x-api-key", "api-key"];

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

  if (selectedRoute?.apiKey) {
    for (const headerName of conflictingAuthHeaders) {
      if (headerName !== selectedAuthHeader) {
        headers.delete(headerName);
      }
    }
  }

  if (selectedRoute?.headers) {
    for (const [key, value] of Object.entries(selectedRoute.headers)) {
      headers.set(key, value);
    }
  }

  if (selectedRoute?.apiKey) {
    const authHeader = selectedAuthHeader;
    const authPrefix = selectedRoute.authPrefix ?? "Bearer ";

    if (!headers.has(authHeader)) {
      headers.set(authHeader, `${authPrefix}${selectedRoute.apiKey}`);
    }
  } else if (!headers.has("authorization") && config.upstreamApiKey) {
    headers.set("authorization", `Bearer ${config.upstreamApiKey}`);
  }

  if (typeof bodyLength === "number") {
    headers.set("content-length", String(bodyLength));
  }

  return headers;
}

function isJsonRequest(headers: IncomingHttpHeaders): boolean {
  const contentTypeHeader = headers["content-type"];
  const contentType = Array.isArray(contentTypeHeader)
    ? contentTypeHeader.join(";").toLowerCase()
    : String(contentTypeHeader ?? "").toLowerCase();

  return contentType.includes("application/json");
}

function parseJsonBody(buffer: Buffer, shouldParse: boolean): { parsed: ParsedJsonBody | null; error: string | null } {
  if (!shouldParse || buffer.length === 0) {
    return { parsed: null, error: null };
  }

  try {
    const parsed = JSON.parse(buffer.toString("utf8"));

    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { parsed: parsed as ParsedJsonBody, error: null };
    }

    return { parsed: null, error: null };
  } catch {
    return { parsed: null, error: "Invalid JSON body." };
  }
}

function parseStatusLikeCode(value: unknown): number | null {
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

function extractRetryStatusFromJsonPayload(payload: unknown): number | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }

  const record = payload as Record<string, unknown>;
  const candidates: unknown[] = [record.status, record.code, record.errorCode];

  const nestedError = record.error;
  if (nestedError && typeof nestedError === "object" && !Array.isArray(nestedError)) {
    const nested = nestedError as Record<string, unknown>;
    candidates.push(nested.status, nested.code, nested.errorCode);
  }

  const nestedErrors = record.errors;
  if (Array.isArray(nestedErrors)) {
    for (const item of nestedErrors) {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        continue;
      }

      const nested = item as Record<string, unknown>;
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

async function detectRetryStatusFromBody(
  upstreamResponse: Response,
  retryStatusCodes: Set<number>,
): Promise<number | null> {
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
  } catch {
    // Ignore probe errors and continue with normal response handling.
  }

  return null;
}

function copyResponseHeaders(upstreamResponse: Response, response: ServerResponse): void {
  for (const [key, value] of upstreamResponse.headers.entries()) {
    if (HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
      continue;
    }

    response.setHeader(key, value);
  }
}

async function fetchWithTimeout(url: string, options: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetchWithDispatcher(url, {
      ...(options as RequestInitWithDispatcher),
      signal: controller.signal,
      dispatcher: upstreamAgent,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

function createClientAbortSignal(
  request: IncomingMessage,
  response: ServerResponse,
): AbortSignal | null {
  const controller = new AbortController();
  let aborted = false;

  const abort = () => {
    if (aborted) {
      return;
    }

    aborted = true;
    controller.abort();
  };

  request.once("aborted", abort);
  response.once("close", () => {
    if (!response.writableEnded) {
      abort();
    }
  });

  return controller.signal;
}

async function fetchWithTimeoutAndClientSignal(
  url: string,
  options: RequestInit,
  timeoutMs: number,
  clientSignal: AbortSignal | null,
): Promise<Response> {
  if (!clientSignal) {
    return fetchWithTimeout(url, options, timeoutMs);
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  const onClientAbort = () => {
    if (!controller.signal.aborted) {
      controller.abort();
    }
  };

  if (clientSignal.aborted) {
    onClientAbort();
  } else {
    clientSignal.addEventListener("abort", onClientAbort, { once: true });
  }

  try {
    return await fetchWithDispatcher(url, {
      ...(options as RequestInitWithDispatcher),
      signal: controller.signal,
      dispatcher: upstreamAgent,
    });
  } finally {
    clearTimeout(timeoutId);
    clientSignal.removeEventListener("abort", onClientAbort);
  }
}

async function disposeBody(response: Response): Promise<void> {
  if (!response.body) {
    return;
  }

  try {
    await response.body.cancel();
  } catch {
    // Body cancellation is best effort.
  }
}

function createSsePrefixedStream(source: Readable, notice: GatewaySwitchNotice): PassThrough {
  const passthrough = new PassThrough();
  passthrough.write(`event: gateway_notice\ndata: ${JSON.stringify(notice)}\n\n`);

  source.on("error", () => {
    passthrough.end();
  });

  source.pipe(passthrough);
  return passthrough;
}

async function readRequestBody(request: IncomingMessage): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalSize = 0;
    let settled = false;

    request.on("data", (chunk: Buffer | string) => {
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

export async function proxyRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const method = (request.method ?? "GET").toUpperCase();
  const supportsBody = method !== "GET" && method !== "HEAD";
  const clientSignal = createClientAbortSignal(request, response);
  const normalizedRequestPath = normalizeRequestPath(request);
  const requestProtocol = resolveGatewayProtocol(request);
  let incomingBody: Buffer = Buffer.alloc(0);

  if (supportsBody) {
    try {
      incomingBody = await readRequestBody(request);
    } catch (error) {
      const isBodyTooLarge =
        error instanceof Error &&
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

  const requestedModel =
    parsedJsonBody &&
    typeof parsedJsonBody.model === "string" &&
    parsedJsonBody.model.trim()
      ? parsedJsonBody.model.trim()
      : null;

  const modelCandidates: Array<string | null> = requestedModel
    ? buildModelCandidates(requestedModel)
    : [null];

  if (requestedModel?.toLowerCase() === AUTO_MODEL && modelCandidates.length === 0) {
    sendJson(response, 400, {
      error: {
        message:
          'No auto model candidates configured. Set routes, GLOBAL_FALLBACK_MODELS, or MODEL_FALLBACK_MAP["auto"].',
      },
    });
    return;
  }

  let lastError: unknown = null;
  let lastAttemptRouteName: string | null = null;
  let switchNotice: GatewaySwitchNotice | null = null;

  for (let attemptIndex = 0; attemptIndex < modelCandidates.length; attemptIndex += 1) {
    const modelId = modelCandidates[attemptIndex];
    let requestPath = normalizedRequestPath;
    let responseFormat: "anthropic-messages" | null = null;
    let requestJsonPayload: Record<string, unknown> | null = null;

    if (supportsBody && parsedJsonBody) {
      requestJsonPayload = {
        ...parsedJsonBody,
        ...(modelId ? { model: modelId } : {}),
      };
    }

    let { upstreamUrl, selectedRoute } = resolveUpstreamTarget(requestPath, modelId);
    lastAttemptRouteName = selectedRoute?.routeName ?? null;

    if (requestJsonPayload) {
      const compatRequest = maybeTransformAnthropicMessagesRequest({
        requestPath,
        upstreamUrl,
        body: requestJsonPayload,
      });

      if (compatRequest.error) {
        console.error(
          buildGatewayLogLine(requestProtocol, "compat_error", {
            path: requestPath,
            route: selectedRoute?.routeName ?? null,
            model: modelId,
            detail: compatRequest.error,
          }),
        );
        sendJson(response, 400, {
          error: {
            message: compatRequest.error,
          },
        });
        return;
      }

      requestPath = compatRequest.requestPath;
      requestJsonPayload = compatRequest.body;
      responseFormat = compatRequest.responseFormat;

      if (responseFormat) {
        upstreamUrl = buildRoutedUpstreamUrl(requestPath, selectedRoute);
      }
    }

    let bodyBuffer = supportsBody && incomingBody.length > 0 ? incomingBody : undefined;

    if (supportsBody && requestJsonPayload) {
      bodyBuffer = Buffer.from(JSON.stringify(requestJsonPayload), "utf8");
    }

    const requestBody = bodyBuffer ? new Uint8Array(bodyBuffer) : undefined;
    const headers = buildUpstreamHeaders(
      request.headers,
      bodyBuffer ? bodyBuffer.length : undefined,
      selectedRoute,
    );

    try {
      const attemptStartedAt = Date.now();
      const upstreamResponse = await fetchWithTimeoutAndClientSignal(
        upstreamUrl,
        {
          method,
          headers,
          body: requestBody,
        },
        config.timeoutMs,
        clientSignal,
      );
      const headerLoadMs = Date.now() - attemptStartedAt;
      const modelForMetric = modelId ?? requestedModel;

      if (upstreamResponse.ok) {
        recordModelLoadSample(modelForMetric, headerLoadMs);
      }

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
          protocol: requestProtocol,
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

      if (!upstreamResponse.ok) {
        await logUpstreamErrorResponse({
          protocol: requestProtocol,
          requestPath,
          upstreamUrl,
          routeName: selectedRoute?.routeName ?? null,
          modelId,
          response: upstreamResponse,
        });
      }

      const attemptCount = attemptIndex + 1;
      const effectiveSwitchNotice: GatewaySwitchNotice | null = switchNotice;

      copyResponseHeaders(upstreamResponse, response);
      response.setHeader("x-gateway-attempt-count", String(attemptCount));

      if (modelId) {
        response.setHeader("x-gateway-model-used", modelId);
      }

      if (effectiveSwitchNotice) {
        response.setHeader("x-gateway-switched", "1");
      }

      logProxyModelRoute({
        protocol: requestProtocol,
        requestedModel,
        usedModel: modelId,
        routeName: selectedRoute?.routeName ?? null,
      });

      response.statusCode = upstreamResponse.status;

      if (!upstreamResponse.body) {
        response.end();
        return;
      }

      if (responseFormat === "anthropic-messages" && isEventStream) {
        const nodeStream = Readable.fromWeb(upstreamResponse.body as any);
        const anthropicStream = nodeStream.pipe(
          createAnthropicMessagesEventStreamTransformer(modelId),
        );

        response.removeHeader("content-length");
        response.setHeader("content-type", "text/event-stream; charset=utf-8");

        if (effectiveSwitchNotice) {
          createSsePrefixedStream(anthropicStream, effectiveSwitchNotice).pipe(response);
          return;
        }

        anthropicStream.on("error", () => {
          if (!response.writableEnded) {
            response.destroy();
          }
        });

        anthropicStream.pipe(response);
        return;
      }

      if (responseFormat === "anthropic-messages" && isJsonResponse && !isEventStream) {
        const rawText = await upstreamResponse.text();
        response.removeHeader("content-length");
        response.setHeader("content-type", "application/json; charset=utf-8");

        try {
          const parsed = JSON.parse(rawText);

          if (!upstreamResponse.ok) {
            response.end(JSON.stringify(transformUpstreamErrorToAnthropicError(parsed, upstreamResponse.status)));
            return;
          }

          const transformed = transformOpenAiChatCompletionToAnthropicMessage(parsed, modelId);

          if (transformed.value) {
            response.end(JSON.stringify(transformed.value));
            return;
          }

          console.error(
            buildGatewayLogLine(requestProtocol, "compat_error", {
              path: requestPath,
              route: selectedRoute?.routeName ?? null,
              model: modelId,
              detail: transformed.error ?? "Unknown transform error",
            }),
          );
          sendJson(response, 502, {
            error: {
              message: "Gateway failed to translate the OpenAI-compatible response to Anthropic format.",
              detail: transformed.error ?? "Unknown transform error",
            },
          });
          return;
        } catch {
          if (!upstreamResponse.ok) {
            response.end(
              JSON.stringify(
                transformUpstreamErrorToAnthropicError(
                  {
                    message: rawText,
                  },
                  upstreamResponse.status,
                ),
              ),
            );
            return;
          }
        }
      }

      if (effectiveSwitchNotice && isJsonResponse && !isEventStream) {
        const rawText = await upstreamResponse.text();
        response.removeHeader("content-length");

        try {
          const parsed = JSON.parse(rawText);

          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            (parsed as Record<string, unknown>).gateway_notice = effectiveSwitchNotice;
            response.end(JSON.stringify(parsed));
            return;
          }
        } catch {
          // Keep original response body when JSON mutation is not possible.
        }

        response.end(rawText);
        return;
      }

      const nodeStream = Readable.fromWeb(upstreamResponse.body as any);

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
    } catch (error) {
      lastError = error;

      if (attemptIndex < modelCandidates.length - 1) {
        continue;
      }
    }
  }

  const timeoutLike =
    lastError &&
    typeof lastError === "object" &&
    "name" in lastError &&
    (lastError as { name?: unknown }).name === "AbortError";
  const errorStatusCode = timeoutLike ? 504 : 502;
  const lastTriedModel = modelCandidates[modelCandidates.length - 1] ?? null;

  logProxyModelRoute({
    protocol: requestProtocol,
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
