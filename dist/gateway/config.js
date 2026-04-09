import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { parse as parseYaml } from "yaml";
dotenv.config();
function parseCsvList(value) {
    if (!value) {
        return [];
    }
    return value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
}
function parsePositiveInteger(value, fallback) {
    if (!value) {
        return fallback;
    }
    const parsed = Number.parseInt(value, 10);
    if (!Number.isInteger(parsed) || parsed <= 0) {
        return fallback;
    }
    return parsed;
}
function parseRetryCodes(value) {
    const defaults = new Set([412, 429, 500, 502, 503, 504]);
    if (!value) {
        return defaults;
    }
    const parsed = value
        .split(",")
        .map((item) => Number.parseInt(item.trim(), 10))
        .filter((code) => Number.isInteger(code) && code >= 100 && code <= 9999);
    return parsed.length > 0 ? new Set(parsed) : defaults;
}
function parseRetryCodesFromConfig(value) {
    if (value === undefined || value === null) {
        return undefined;
    }
    if (!Array.isArray(value)) {
        throw new Error('"retryStatusCodes" must be an array.');
    }
    const parsed = value
        .map((item) => {
        if (typeof item === "number") {
            return item;
        }
        if (typeof item === "string") {
            return Number.parseInt(item.trim(), 10);
        }
        return Number.NaN;
    })
        .filter((code) => Number.isInteger(code) && code >= 100 && code <= 9999);
    if (parsed.length === 0) {
        throw new Error('"retryStatusCodes" must include at least one valid status code (100-9999).');
    }
    return new Set(parsed);
}
function parseModelFallbackMap(value) {
    if (!value) {
        return {};
    }
    try {
        const parsed = JSON.parse(value);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new Error("MODEL_FALLBACK_MAP must be a JSON object.");
        }
        return Object.fromEntries(Object.entries(parsed).map(([model, fallbacks]) => {
            if (!Array.isArray(fallbacks)) {
                throw new Error(`Fallback list for "${model}" must be an array.`);
            }
            return [
                model,
                fallbacks.map((item) => String(item).trim()).filter(Boolean),
            ];
        }));
    }
    catch (error) {
        throw new Error(`Invalid MODEL_FALLBACK_MAP: ${error.message}`);
    }
}
function parseRouteHeaders(value, routeName) {
    if (value === undefined) {
        return {};
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`Route headers for "${routeName}" must be a YAML object.`);
    }
    return Object.fromEntries(Object.entries(value).map(([rawKey, rawValue]) => {
        const key = String(rawKey).trim();
        const val = String(rawValue).trim();
        if (!key) {
            throw new Error(`Route headers for "${routeName}" contains an empty key.`);
        }
        return [key, val];
    }));
}
function parseModelList(value, routeName) {
    if (typeof value === "string") {
        const normalized = value.trim();
        return normalized ? [normalized] : [];
    }
    if (!Array.isArray(value)) {
        throw new Error(`Route "${routeName}" must include "model" as string or array.`);
    }
    return value.map((item) => String(item).trim()).filter(Boolean);
}
function resolveRouteApiKey(rawRoute, defaults) {
    const apiKeyInline = typeof rawRoute.apiKey === "string" ? rawRoute.apiKey.trim() : "";
    if (apiKeyInline) {
        return apiKeyInline;
    }
    const apiKeyEnv = typeof rawRoute.apiKeyEnv === "string" ? rawRoute.apiKeyEnv.trim() : "";
    if (apiKeyEnv) {
        return process.env[apiKeyEnv] ?? "";
    }
    if (defaults.apiKey) {
        return defaults.apiKey;
    }
    return defaults.apiKeyEnv ? process.env[defaults.apiKeyEnv] ?? "" : "";
}
function normalizeGlobalRouteDefaults(value) {
    if (value === undefined || value === null) {
        return {};
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("Route defaults must be an object.");
    }
    const defaults = value;
    return {
        authHeader: typeof defaults.authHeader === "string" && defaults.authHeader.trim()
            ? defaults.authHeader.trim().toLowerCase()
            : undefined,
        authPrefix: typeof defaults.authPrefix === "string" ? defaults.authPrefix : undefined,
        apiKey: typeof defaults.apiKey === "string" ? defaults.apiKey.trim() : undefined,
        apiKeyEnv: typeof defaults.apiKeyEnv === "string" && defaults.apiKeyEnv.trim()
            ? defaults.apiKeyEnv.trim()
            : undefined,
        headers: parseRouteHeaders(defaults.headers, "defaults"),
        isBaseUrl: typeof defaults.isBaseUrl === "boolean" ? defaults.isBaseUrl : undefined,
        enabled: typeof defaults.enabled === "boolean" ? defaults.enabled : undefined,
    };
}
function normalizeRouteConfig(rawRoute, routeName, defaults) {
    if (!rawRoute || typeof rawRoute !== "object" || Array.isArray(rawRoute)) {
        throw new Error(`Route "${routeName}" must be an object.`);
    }
    const url = typeof rawRoute.url === "string" ? rawRoute.url.trim() : "";
    if (!url) {
        throw new Error(`Route "${routeName}" must include a non-empty "url".`);
    }
    const models = parseModelList(rawRoute.model ?? rawRoute.models, routeName);
    if (models.length === 0) {
        throw new Error(`Route "${routeName}" must include at least one model.`);
    }
    const authHeader = typeof rawRoute.authHeader === "string" && rawRoute.authHeader.trim()
        ? rawRoute.authHeader.trim().toLowerCase()
        : defaults.authHeader ?? "authorization";
    const authPrefix = typeof rawRoute.authPrefix === "string" ? rawRoute.authPrefix : defaults.authPrefix ?? "Bearer ";
    const isBaseUrl = typeof rawRoute.isBaseUrl === "boolean"
        ? rawRoute.isBaseUrl
        : Boolean(defaults.isBaseUrl);
    const enabled = typeof rawRoute.enabled === "boolean" ? rawRoute.enabled : defaults.enabled ?? true;
    const headers = {
        ...(defaults.headers ?? {}),
        ...parseRouteHeaders(rawRoute.headers, routeName),
    };
    return {
        routeName,
        url,
        authHeader,
        authPrefix,
        apiKey: resolveRouteApiKey(rawRoute, defaults),
        headers,
        isBaseUrl,
        enabled,
        models,
    };
}
function parseRouteArray(value, defaults) {
    if (!Array.isArray(value)) {
        throw new Error('Route config must include "routes" as an array.');
    }
    return value.map((entry, index) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
            throw new Error(`Route entry at index ${index} must be an object.`);
        }
        const routeData = entry;
        const name = typeof routeData.name === "string" ? routeData.name.trim() : "";
        const routeName = name || `routes[${index}]`;
        return normalizeRouteConfig(routeData, routeName, defaults);
    });
}
function parseModelRouteConfigFile(filePathRaw) {
    const filePath = String(filePathRaw).trim();
    if (!filePath) {
        throw new Error("Route config path cannot be empty.");
    }
    const resolvedPath = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
    let raw = "";
    try {
        raw = fs.readFileSync(resolvedPath, "utf8");
    }
    catch (error) {
        throw new Error(`Failed to read route config file "${resolvedPath}": ${error instanceof Error ? error.message : "Unknown error"}`);
    }
    let parsed;
    try {
        parsed = parseYaml(raw);
    }
    catch (error) {
        throw new Error(`Invalid route config YAML at "${resolvedPath}": ${error instanceof Error ? error.message : "Unknown error"}`);
    }
    let defaults = {};
    let routeEntries;
    let retryStatusCodesFromFile;
    if (Array.isArray(parsed)) {
        routeEntries = parsed;
    }
    else if (parsed && typeof parsed === "object") {
        const objectParsed = parsed;
        retryStatusCodesFromFile = parseRetryCodesFromConfig(objectParsed.retryStatusCodes);
        defaults = normalizeGlobalRouteDefaults(objectParsed.defaults ?? objectParsed.global ?? objectParsed.auth);
        routeEntries = objectParsed.routes;
    }
    else {
        throw new Error(`Route config file "${resolvedPath}" must be a YAML object or array.`);
    }
    const parsedRoutes = parseRouteArray(routeEntries, defaults);
    const modelRouteMap = {};
    for (const route of parsedRoutes) {
        if (!route.enabled) {
            continue;
        }
        const { routeName, models, enabled: _enabled, ...routeConfig } = route;
        for (const modelId of models) {
            if (modelRouteMap[modelId]) {
                throw new Error(`Duplicate model "${modelId}" found in enabled routes (route "${routeName}").`);
            }
            modelRouteMap[modelId] = {
                ...routeConfig,
                routeName,
            };
        }
    }
    return {
        modelRouteMap,
        retryStatusCodes: retryStatusCodesFromFile,
    };
}
function loadRouteFileConfig() {
    const defaultRouteConfigPath = path.resolve(process.cwd(), "routes.yml");
    if (!fs.existsSync(defaultRouteConfigPath)) {
        throw new Error(`Missing routes config file at "${defaultRouteConfigPath}". Create routes.yml in project root.`);
    }
    return parseModelRouteConfigFile(defaultRouteConfigPath);
}
const host = process.env.HOST ?? "0.0.0.0";
const port = Number.parseInt(process.env.PORT ?? "8787", 10);
const timeoutMs = Number.parseInt(process.env.REQUEST_TIMEOUT_MS ?? "60000", 10);
const upstreamMaxConnections = parsePositiveInteger(process.env.UPSTREAM_MAX_CONNECTIONS, 200);
const upstreamKeepAliveTimeoutMs = parsePositiveInteger(process.env.UPSTREAM_KEEPALIVE_TIMEOUT_MS, 60_000);
const upstreamKeepAliveMaxTimeoutMs = parsePositiveInteger(process.env.UPSTREAM_KEEPALIVE_MAX_TIMEOUT_MS, 300_000);
const upstreamBaseUrl = (process.env.UPSTREAM_BASE_URL ?? "https://api.openai.com").replace(/\/+$/, "");
const routeFileConfig = loadRouteFileConfig();
if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be a valid TCP port number.");
}
if (!Number.isInteger(timeoutMs) || timeoutMs < 1000) {
    throw new Error("REQUEST_TIMEOUT_MS must be an integer >= 1000.");
}
export const config = {
    host,
    port,
    timeoutMs,
    upstreamBaseUrl,
    upstreamApiKey: process.env.UPSTREAM_API_KEY ?? "",
    upstreamMaxConnections,
    upstreamKeepAliveTimeoutMs,
    upstreamKeepAliveMaxTimeoutMs,
    retryStatusCodes: routeFileConfig.retryStatusCodes ?? parseRetryCodes(process.env.RETRY_STATUS_CODES),
    globalFallbackModels: parseCsvList(process.env.GLOBAL_FALLBACK_MODELS),
    modelFallbackMap: parseModelFallbackMap(process.env.MODEL_FALLBACK_MAP),
    modelRouteMap: routeFileConfig.modelRouteMap,
};
