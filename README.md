# openclaw-autoproxy

OpenClaw 自动代理网关 — 在本地提供 OpenAI 兼容的代理，基于 `routes.yml` 配置上游路由并支持模型自动回退。

## 快速开始

1. 全局安装（推荐）：

```bash
npm i -g openclaw-autoproxy@latest
```

2. 当前目录编辑路由配置：

```bash
vim routes.yml
```

3. 启动代理（已安装模式）：

```bash
openclaw-autoproxy start
```

或者不安装、直接使用 `npx`：

```bash
npx openclaw-autoproxy@1.0.3 start
```

启动后，本地 OpenAI 兼容接口通常可通过 `http://127.0.0.1:8787/v1/*` 访问（端口可通过配置更改）。

## 简要示例 `routes.yml`

```yaml
## 全局默认配置（推荐使用 ai gateway 时使用）
## 或者不在配置文件设置 token，使用时通过 curl 携带
defaults:
  authHeader: cf-aig-authorization
  authPrefix: "Bearer "
  apiKey: xxxxxxxxxxxxxxxxxx
retryStatusCodes: [412, 429, 500, 502, 503, 504]

routes:
  - name: local-3000
    url: http://localhost:3000
    model: gpt-4.1
    ## 路由级别 token配置（优先级高于全局）
    apiKeyEnv: UPSTREAM_API_KEY

  - name: local-4000
    url: http://localhost:4000
    model: gpt-3.5-turbo
    ## 路由级别 token配置（优先级高于全局）
    apiKeyEnv: UPSTREAM_API_KEY
```

## 常用命令（示例）

安装并启动：

```bash
npm i -g openclaw-autoproxy@latest
vim routes.yml
openclaw-autoproxy start
```

直接运行（推荐 win 使用 npx）：

```bash
npx openclaw-autoproxy@1.0.3 start
```

## 说明

- `routes.yml`：项目根目录下的上游路由与认证配置。
- `UPSTREAM_API_KEY`：可通过环境变量提供上游认证密钥；也可在 `routes.yml` 中使用 `apiKey` 明文（不推荐）。

更多高级配置与实现细节请查看 `src/gateway` 目录。
