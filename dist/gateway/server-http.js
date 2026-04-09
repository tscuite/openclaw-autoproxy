import { createServer } from "node:http";
import { config } from "./config.js";
import { DEFAULT_MODEL_HEALTH_WINDOW_MS, getModelHealthWindow, } from "./model-load-metrics.js";
import { proxyRequest } from "./proxy.js";
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
function sendText(response, statusCode, body) {
    if (response.writableEnded) {
        return;
    }
    response.statusCode = statusCode;
    response.setHeader("content-type", "text/plain; charset=utf-8");
    response.setHeader("content-length", Buffer.byteLength(body));
    response.end(body);
}
function resolveRequestUrl(request) {
    const rawUrl = request.url ?? "/";
    try {
        return new URL(rawUrl, "http://localhost");
    }
    catch {
        const normalized = rawUrl.startsWith("/") ? rawUrl : `/${rawUrl}`;
        return new URL(normalized, "http://localhost");
    }
}
function resolvePathname(request) {
    return resolveRequestUrl(request).pathname;
}
function formatTableNumber(value) {
    if (!Number.isFinite(value)) {
        return "-";
    }
    if (Number.isInteger(value)) {
        return String(value);
    }
    return value.toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1");
}
function padTableCell(value, width, align) {
    return align === "right" ? value.padStart(width, " ") : value.padEnd(width, " ");
}
function buildModelHealthTable(windowHours, models) {
    const columns = [
        { header: "Model", align: "left", value: (row) => row.model },
        {
            header: "Code",
            align: "right",
            value: (row) => row.lastStatusCode === null ? "-" : String(row.lastStatusCode),
        },
        { header: "Avg(ms)", align: "right", value: (row) => formatTableNumber(row.avgResponseMs) },
        { header: "Last(ms)", align: "right", value: (row) => formatTableNumber(row.lastResponseMs) },
        { header: "Count", align: "right", value: (row) => String(row.accessCount) },
        { header: "OK%", align: "right", value: (row) => `${formatTableNumber(row.successRatePct)}%` },
    ];
    const widths = columns.map((column) => {
        const rowWidths = models.map((row) => column.value(row).length);
        return Math.max(column.header.length, ...rowWidths, 1);
    });
    const header = columns
        .map((column, index) => padTableCell(column.header, widths[index] ?? column.header.length, column.align))
        .join(" | ");
    const divider = widths.map((width) => "-".repeat(width)).join("-+-");
    const rows = models.map((row) => columns
        .map((column, index) => padTableCell(column.value(row), widths[index] ?? 0, column.align))
        .join(" | "));
    return [
        `Gateway Health (last ${formatTableNumber(windowHours)}h)`,
        `Status: ok`,
        "",
        header,
        divider,
        ...(rows.length > 0 ? rows : ["No model traffic recorded in the last 12 hours."]),
    ].join("\n");
}
function isGatewayApiPath(pathname) {
    return (pathname === "/v1" ||
        pathname.startsWith("/v1/") ||
        pathname === "/anthropic" ||
        pathname.startsWith("/anthropic/"));
}
async function handleRequest(request, response) {
    const method = (request.method ?? "GET").toUpperCase();
    const requestUrl = resolveRequestUrl(request);
    const pathname = requestUrl.pathname;
    if ((method === "GET" || method === "HEAD") && pathname === "/health") {
        const modelHealth = getModelHealthWindow(DEFAULT_MODEL_HEALTH_WINDOW_MS);
        const tableOutput = buildModelHealthTable(modelHealth.windowHours, modelHealth.models);
        if (requestUrl.searchParams.get("format")?.toLowerCase() !== "json") {
            sendText(response, 200, tableOutput);
            return;
        }
        sendJson(response, 200, {
            status: "ok",
            retryStatusCodes: Array.from(config.retryStatusCodes),
            enabledRouteCount: Object.keys(config.modelRouteMap).length,
            modelHealthWindowHours: modelHealth.windowHours,
            modelHealth: modelHealth.models,
            modelHealthTable: tableOutput,
            modelLoadWindowHours: modelHealth.windowHours,
            modelLoadRanking: modelHealth.models,
        });
        return;
    }
    if (isGatewayApiPath(pathname)) {
        await proxyRequest(request, response);
        return;
    }
    sendJson(response, 404, {
        error: {
            message: "Route not found. Use /v1/*, /anthropic/*, or /health.",
        },
    });
}
export function createGatewayHttpServer() {
    return createServer((request, response) => {
        void handleRequest(request, response).catch((error) => {
            sendJson(response, 500, {
                error: {
                    message: "Unexpected gateway error.",
                    detail: error instanceof Error ? error.message : "Unknown error",
                },
            });
        });
    });
}
