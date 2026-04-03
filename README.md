# openclaw-autoproxy (OpenClaw Auto Gateway)

Local proxy gateway that forwards OpenAI-compatible APIs and automatically switches model IDs when upstream returns retryable status codes (for example 412).

## Features
```
npx openclaw-autoproxy@1.0.3 start
```

- OpenAI-compatible proxy endpoint: `/v1/*`
- Automatic model fallback on retryable statuses for `model: auto` only (default: 412, 429, 500, 502, 503, 504)
- Model-based route selection: different models can use different upstream URLs and auth headers
- Per-model and global fallback chains
- TypeScript runtime powered by `tsx`
- Node.js HTTP gateway server (openclaw-style)
- Cross-platform startup on macOS and Windows (Node.js 18+)
- Health endpoint: `/health`

## Quick Start

1. Install Node.js 18 or newer.
2. Install dependencies:

```bash
npm install
```

3. Create local env file:

macOS/Linux:

```bash
cp .env.example .env
```

Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

4. Edit `.env` (runtime options) and `routes.yml` (all upstream route mappings and auth).
5. Start the gateway:

```bash
npm run dev
```

Production mode:

```bash
npm start
```

## Global CLI Usage

You can install this project globally and run it via `openclaw-autoproxy`:

```bash
npm i -g .
openclaw-autoproxy gateway start
```

Watch mode:

```bash
openclaw-autoproxy gateway dev
```

Show CLI help:

```bash
openclaw-autoproxy gateway help
```

Backward-compatible aliases are still supported:

```bash
openclaw-autoproxy start
openclaw-autoproxy dev
openclaw-autoproxy help
```

## OpenAI-Compatible Calls For 3 Models

After starting gateway locally, always call the local OpenAI-style endpoint:

```bash
curl -X POST http://127.0.0.1:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "GLM-4.7-Flash",
    "messages": [{"role":"user","content":"你好"}]
  }'
```

```bash
curl -X POST http://127.0.0.1:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "doubao-seed-2-0-pro-260215",
    "messages": [{"role":"user","content":"你好"}]
  }'
```

```bash
curl -X POST http://127.0.0.1:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "ernie-4.5-turbo-128k",
    "messages": [{"role":"user","content":"你好"}]
  }'
```

## API

- `ALL /v1/*`: Forward to upstream; automatic model fallback is used only when request model is `auto`.
- `GET /health`: Health check and active retry status list.

## Project Structure

```text
src/
  gateway/
    config.ts
    proxy.ts
    server-http.ts
    server.impl.ts
    server.ts
```

### Example Chat Request

```bash
curl -X POST http://127.0.0.1:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <your-upstream-token>" \
  -d '{
    "model": "gpt-4.1",
    "messages": [{"role": "user", "content": "hello"}],
    "temperature": 0.2
  }'
```

Then call local gateway:

```bash
curl -X POST http://127.0.0.1:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "GLM-4.7-Flash",
    "messages": [{"role":"user","content":"你好"}]
  }'
```

### Helpful Response Headers

- `x-gateway-model-used`: The actual model used by this attempt.
- `x-gateway-attempt-count`: Number of attempts before returning response.
- `x-gateway-switched`: `1` when model fallback happened in this response.

### Switch Notice In Response Data

- JSON response: when fallback happened, gateway appends `gateway_notice` at top-level JSON.
- SSE response: when fallback happened, gateway prepends one event:

```text
event: gateway_notice
data: {"fromModel":"...","toModel":"...","triggerStatus":412,...}
```

## Fallback Strategy

The gateway behavior is split by request model:

1. `model != auto`: pinned mode, only the requested model is used (no automatic switch).
2. `model == auto`: automatic mode, candidates are all enabled route models from `routes.yml`, and each request uses a round-robin start model.

When upstream returns a status in `retryStatusCodes` (from `routes.yml`), automatic mode retries using the next candidate model in the same rotated list. If this key is absent, it falls back to `RETRY_STATUS_CODES` env.

## Model Route Configuration

`routes.yml` is loaded automatically from the project root.

Recommended YAML shape:

- `defaults`: optional global auth defaults used by all routes
- `retryStatusCodes`: optional array of retryable HTTP status codes (for example `[412, 429, 500, 502, 503, 504]`)
- `routes`: required array of route objects

Top-level array is also supported when you do not need global defaults.

Each route object supports:

- `name`: optional logical route name
- `url`: upstream URL
- `model`: model list (or a single string)
- `authHeader`: optional auth header name
- `authPrefix`: optional auth value prefix (default `Bearer `)
- `apiKey`: inline token value (preferred in this setup)
- `apiKeyEnv`: optional env-based token fallback
- `headers`: optional fixed headers map
- `isBaseUrl`: optional boolean to force base URL behavior
- `enabled`: optional boolean (default `true`), set `false` to disable the route without deleting it

`routes.yml` is required and loaded from the project root.

## Notes

- If client request already includes `Authorization`, gateway forwards it.
- If client request does not include `Authorization`, gateway uses `UPSTREAM_API_KEY`.
- Streaming responses are forwarded as stream when an attempt succeeds.
- Requests with invalid JSON body return `400`.