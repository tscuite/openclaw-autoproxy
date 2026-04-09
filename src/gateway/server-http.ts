import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { config } from "./config.js";
import { getModelLoadRankingHealth } from "./model-load-metrics.js";
import { proxyRequest } from "./proxy.js";

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

function resolvePathname(request: IncomingMessage): string {
  const rawUrl = request.url ?? "/";

  try {
    return new URL(rawUrl, "http://localhost").pathname;
  } catch {
    return rawUrl.startsWith("/") ? rawUrl : `/${rawUrl}`;
  }
}

function isGatewayApiPath(pathname: string): boolean {
  return (
    pathname === "/v1" ||
    pathname.startsWith("/v1/") ||
    pathname === "/anthropic" ||
    pathname.startsWith("/anthropic/")
  );
}

async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const method = (request.method ?? "GET").toUpperCase();
  const pathname = resolvePathname(request);

  if ((method === "GET" || method === "HEAD") && pathname === "/health") {
    const modelLoadHealth = getModelLoadRankingHealth(12 * 60 * 60 * 1000);

    sendJson(response, 200, {
      status: "ok",
      retryStatusCodes: Array.from(config.retryStatusCodes),
      enabledRouteCount: Object.keys(config.modelRouteMap).length,
      modelLoadWindowHours: modelLoadHealth.windowHours,
      modelLoadRanking: modelLoadHealth.rankedModels,
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

export function createGatewayHttpServer(): Server {
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
