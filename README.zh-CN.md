# 在 OpenClaw 中让大模型 API 永远可用

OpenClaw 自动代理网关 — 在本地同时提供 OpenAI 兼容的 `/v1/*` 和 Anthropic 兼容的 `/anthropic/*` 接口，转发请求到配置的上游，并根据 `routes.yml` 支持模型自动回退与路由选择。

## 快速开始

1. 全局安装（推荐）：

```bash
npm i -g openclaw-autoproxy@latest
```

2. 编辑路由配置（位于项目根目录）：

```bash
vim routes.yml
```

3. 启动代理（已安装模式）：

```bash
openclaw-autoproxy start
```

或使用 `npx`（无需安装）：

```bash
npx openclaw-autoproxy@latest start
```

启动后，本地 OpenAI 兼容接口通常可通过 `http://127.0.0.1:8787/v1/*` 访问，本地 Anthropic 兼容接口可通过 `http://127.0.0.1:8787/anthropic/*` 访问（端口可配置）。

## 示例 `routes.yml`

```yaml
# 可选全局默认设置
defaults:
  authHeader: cf-aig-authorization
  authPrefix: "Bearer "
  apiKey: xxxxxxxxxxxxxxxxxx

retryStatusCodes: [412, 429, 500, 502, 503, 504]

routes:
  - name: openai
    url: https://api.openai.com
    model: gpt-4.1
    # 路由级 token（优先于 defaults）
    apiKeyEnv: UPSTREAM_API_KEY

  - name: azure
    url: https://your-azure-endpoint
    model: gpt-3.5-turbo
    apiKeyEnv: UPSTREAM_API_KEY
```

## 常用命令

- 启动：`openclaw-autoproxy start`
- 开发（热重载）：`openclaw-autoproxy dev`
- 帮助：`openclaw-autoproxy help`
- 发布：`npm publish --registry=https://registry.npmjs.org --access public`

快速示例（安装并立即启动）：

```bash
npm i -g openclaw-autoproxy@latest
vim routes.yml
openclaw-autoproxy start
```

使用 npx 直接运行（win）：

```bash
npx openclaw-autoproxy@latest start
```

## 使用示例

通过本地代理调用模型（示例）：

```bash
curl -X POST http://127.0.0.1:8787/v1/chat/completions \
  --header 'Content-Type: application/json' \
  --data '{
    "model": "auto",
    "messages": [
      {
        "role": "user",
        "content": "你是啥模型"
      }
    ]
  }'
```

说明：
- 使用 `model: "auto"` 时，网关会在 `routes.yml` 中已启用的候选模型间自动切换并在可重试的上游错误时进行回退。
- 若希望指定具体模型，请替换 `"model": "auto"` 为目标模型名（例如 `"gpt-4.1"`）。

## Anthropic 兼容说明

- 本地 `/anthropic/v1/messages` 在命中 OpenAI 风格上游时，会把 Anthropic Messages API 请求转换为 OpenAI `chat/completions` 请求。
- 当前转换同时支持非流式和流式的文本/工具调用返回，即使选中的上游是 OpenAI 风格路由也可以使用 Anthropic Messages 流式接口。
- 当上游返回 `4xx` 或 `5xx` 时，网关现在会输出一条精简的 `[gateway] upstream_error ...` 日志，包含路由、模型、上游 URL 和响应体摘要。

## 对接 Claude Code

Claude Code 使用 Anthropic 风格接口。这个网关在本地暴露 `/anthropic/*`，并在转发到上游时自动映射为 `/v1/*`。

让 Claude Code 指向本地网关：

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8787/anthropic
export ANTHROPIC_API_KEY=dummy-key
```

说明：
- 如果上游鉴权由网关路由凭证负责，`ANTHROPIC_API_KEY` 可以是占位值。
- 为兼容历史配置，当路由 URL 固定为 `/v1/chat/completions` 时，网关也会自动把 Claude 相关路径（`/v1/messages*`、`/v1/models`、`/v1/complete`）重写到对应上游路径。

## 说明

- `routes.yml`：项目根目录下的上游路由与认证配置。
- `UPSTREAM_API_KEY`：建议通过环境变量提供上游认证密钥；`apiKey` 可用于临时或测试场景但不推荐在生产中明文存放。
- 如果某条路由本身就是通过标准 `Authorization` 头鉴权，客户端传入的 `Authorization` 会继续转发，除非被路由凭证覆盖。如果某条路由使用 `cf-aig-authorization` 这类非标准鉴权头，网关会移除冲突的客户端认证头，例如 `Authorization` 和 `x-api-key`，避免把本地 dummy key 或不兼容的 provider token 透传到上游。
- 当发生自动回退时，网关可能在 JSON 返回中附加 `gateway_notice`，或在 SSE 中发送 `gateway_notice` 事件。

更多高级配置与实现细节请查看 `src/gateway` 目录。
