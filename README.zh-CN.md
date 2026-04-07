# 在 OpenClaw 中让大模型 API 永远可用

OpenClaw 自动代理网关 — 在本地提供 OpenAI 兼容的代理，转发 `/v1/*` 请求到配置的上游，并根据 `routes.yml` 支持模型自动回退与路由选择。

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

启动后，本地 OpenAI 兼容接口通常可通过 `http://127.0.0.1:8787/v1/*` 访问（端口可配置）。

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

## 说明

- `routes.yml`：项目根目录下的上游路由与认证配置。
- `UPSTREAM_API_KEY`：建议通过环境变量提供上游认证密钥；`apiKey` 可用于临时或测试场景但不推荐在生产中明文存放。
- 如果客户端请求包含 `Authorization`，网关将直接转发；否则会使用路由级或全局凭证。
- 当发生自动回退时，网关可能在 JSON 返回中附加 `gateway_notice`，或在 SSE 中发送 `gateway_notice` 事件。

更多高级配置与实现细节请查看 `src/gateway` 目录。
