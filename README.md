# Documentation: [English](README.md) · [简体中文](README.zh-CN.md)

# Make Large Model APIs Always Available in OpenClaw

OpenClaw Auto Proxy Gateway — a local proxy that exposes OpenAI-compatible `/v1/*` and Anthropic-compatible `/anthropic/*` endpoints, forwarding requests to configured upstreams and supporting automatic model fallback based on `routes.yml`.

## Quick start

1. Install globally (recommended):

```bash
npm i -g openclaw-autoproxy@latest
```

2. Edit the route configuration in the project root:

```bash
vim routes.yml
```

3. Start the gateway (installed mode):

```bash
openclaw-autoproxy start
```

Or run without installing (via `npx`):

```bash
npx openclaw-autoproxy@latest start
```

After starting, the local OpenAI-compatible endpoint is usually available at `http://127.0.0.1:8787/v1/*`, and the local Anthropic-compatible endpoint at `http://127.0.0.1:8787/anthropic/*` (port is configurable).

## Example `routes.yml`

```yaml
# Optional global defaults
defaults:
  authHeader: cf-aig-authorization
  authPrefix: "Bearer "
  apiKey: xxxxxxxxxxxxxxxxxx

retryStatusCodes: [412, 429, 500, 502, 503, 504]

routes:
  - name: openai
    url: http://api.openai.com
    model: gpt-4.1
    # Route-level token (overrides defaults)
    apiKeyEnv: UPSTREAM_API_KEY

  - name: azure
    url: http://azure-openai-endpoint
    model: gpt-3.5-turbo
    apiKeyEnv: UPSTREAM_API_KEY
```

## Common commands

- Start: `openclaw-autoproxy start`
- Dev (watch): `openclaw-autoproxy dev`
- Help: `openclaw-autoproxy help`

Quick run (installed):

```bash
npm i -g openclaw-autoproxy@latest
vim routes.yml
openclaw-autoproxy start
```

Quick run (npx):

```bash
npx openclaw-autoproxy@latest start
```

## Usage example

Call the gateway locally:

```bash
curl -X POST http://127.0.0.1:8787/v1/chat/completions \
  --header 'Content-Type: application/json' \
  --data '{
    "model": "auto",
    "messages": [
      {
        "role": "user",
        "content": "what model are you"
      }
    ]
  }'
```

Notes:
- Using `"model": "auto"` causes the gateway to automatically rotate and fallback between candidate models configured in `routes.yml` when upstream returns retryable errors.
- To pin a specific model, replace `"auto"` with the desired model name (for example, `"gpt-4.1"`).

## Anthropic Compatibility

- The local `/anthropic/v1/messages` endpoint can translate Anthropic Messages API requests into OpenAI-compatible `chat/completions` requests when the selected upstream route is OpenAI-style rather than native Anthropic.
- This translation covers both non-streaming and streaming text/tool-call responses for OpenAI-style upstream routes.
- When an upstream returns `4xx` or `5xx`, the gateway now logs a compact `[gateway] upstream_error ...` line with the selected route, model, upstream URL, and a response body snippet.


## Notes

- `routes.yml` is loaded from the project root.
- Prefer `UPSTREAM_API_KEY` as an environment variable for upstream authentication. Route-level `apiKey` is supported but not recommended for production.
- If a route authenticates with the standard `Authorization` header, the client `Authorization` header is forwarded unless route credentials override it. If a route authenticates with a different header such as `cf-aig-authorization`, the gateway strips conflicting client auth headers such as `Authorization` and `x-api-key` to avoid leaking dummy or incompatible provider tokens upstream.
- Streaming responses are forwarded as streams when an attempt succeeds.
- When automatic model fallback occurs, the gateway may append a `gateway_notice` in JSON responses or emit a `gateway_notice` SSE event.

See the implementation and more configuration options under `src/gateway`.

