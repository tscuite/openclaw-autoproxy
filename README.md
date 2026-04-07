# openclaw-autoproxy

OpenClaw Auto Proxy Gateway — a local OpenAI-compatible proxy that forwards `/v1/*` requests to configured upstreams and supports automatic model fallback based on `routes.yml`.

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
npx openclaw-autoproxy@1.0.3 start
```

After starting, the local OpenAI-compatible endpoint is usually available at `http://127.0.0.1:8787/v1/*` (port is configurable).

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
npx openclaw-autoproxy@1.0.3 start
```

## Notes

- `routes.yml` is loaded from the project root.
- Prefer `UPSTREAM_API_KEY` as an environment variable for upstream authentication. Route-level `apiKey` is supported but not recommended for production.
- If the client request includes an `Authorization` header, the gateway forwards it; otherwise the gateway uses route-level or global credentials.
- Streaming responses are forwarded as streams when an attempt succeeds.
- When automatic model fallback occurs, the gateway may append a `gateway_notice` in JSON responses or emit a `gateway_notice` SSE event.

See the implementation and more configuration options under `src/gateway`.

