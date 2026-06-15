# claude-trace

[English](README.md) | [简体中文](README.zh-CN.md)

记录 **Claude Code**、**OpenCode** 与 **Codex CLI** 的 API 流量。在自包含 HTML 查看器中查看系统提示词、工具输出、思考块以及完整请求/响应数据。

**[mariozechner/claude-trace](https://github.com/badlogic/lemmy/tree/main/apps/claude-trace) 的分支版本**，扩展支持 [Claude Code V2+](https://docs.anthropic.com/en/docs/claude-code) 原生二进制、独立的 **[OpenCode](https://opencode.ai)** 命令（多 provider 拦截，Anthropic 与 OpenAI API 格式），以及 **[Codex CLI](https://developers.openai.com/codex/cli) ChatGPT OAuth** 追踪（通过 ChatGPT 账号登录 —— 多数用户的默认 Codex 认证方式）。

## 支持的工具

| 工具 | CLI 命令 | 日志目录 | 拦截方式 |
|------|----------|----------|----------|
| **Claude Code** | `claude-trace` | `.claude-trace/` | V1：`fetch()` 钩子 · V2+：反向代理（`ANTHROPIC_BASE_URL`） |
| **OpenCode** | `opencode-trace` | `.opencode-trace/` | 反向代理 + 模型路由；支持 Anthropic 与 OpenAI 格式 |
| **Codex CLI** | `codex-trace` | `.codex-trace/` | 反向代理（`CODEX_HOME` 覆盖）；**ChatGPT OAuth** 与 OpenAI API Key（Responses API） |

三条命令共用同一套 HTML 报告界面、JSONL/JSON 导出，以及 `--index` 会话摘要功能。

## 快速开始

```bash
npm install -g @hanqunfeng/claude-trace

# Claude Code
claude-trace

# OpenCode
opencode-trace

# Codex CLI
codex-trace
```

会话结束后会自动在浏览器中打开最新 HTML 报告（可用 `--no-open` 关闭）。

## 安装

### 从 npm 安装

```bash
npm install -g @hanqunfeng/claude-trace
```

### 从源码安装

```bash
git clone https://github.com/hanqunfeng/claude-trace.git
cd claude-trace
npm run setup   # 安装根目录 + frontend 依赖
npm run build
npm link        # 可选：全局可用 claude-trace、opencode-trace 与 codex-trace
# 不 link 则用 node dist/cli/cli.js / node dist/cli/opencode-cli.js / node dist/cli/codex-cli.js
```

## Claude Code（`claude-trace`）

### 使用

```bash
# 启动 Claude Code 并记录日志（自动识别 V1 JS / V2+ 原生二进制）
claude-trace

# 记录所有 API 请求（代理模式默认只记录 /v1/messages）
claude-trace --include-all-requests

# 记录敏感 header 且不脱敏（请谨慎使用）
claude-trace --include-sensitive-headers

# 向 Claude 传递参数
claude-trace --run-with chat --model sonnet-3.5

# 指定 Claude 二进制路径
claude-trace --claude-path /usr/local/Caskroom/claude-code/2.1.153/claude

# 提取 OAuth token（V1 Node.js 路径）
claude-trace --extract-token

# 从已有 .jsonl 生成 HTML 报告
claude-trace --generate-html logs.jsonl report.html

# 生成会话摘要与可搜索索引
claude-trace --index

claude-trace --help
```

日志路径：当前目录 `.claude-trace/log-YYYY-MM-DD-HH-MM-SS.{jsonl,json,html}`。

### CLI 选项

| 参数 | 说明 |
|------|------|
| `--include-all-requests` | 记录所有 API 流量，不仅限于 `/v1/messages` |
| `--include-sensitive-headers` | 记录 auth token、cookie 等，不做脱敏 |
| `--log NAME` | 自定义日志文件名（不含扩展名） |
| `--claude-path PATH` | Claude 二进制路径（省略则自动检测） |
| `--no-open` | 生成 HTML 后不自动打开浏览器 |
| `--run-with ARGS...` | 将后续参数传给 Claude |
| `--extract-token` | 提取 OAuth token 后退出 |
| `--generate-html FILE [OUT]` | 从 JSONL 生成 HTML 报告 |
| `--index` | 生成会话摘要与索引 |

### Claude Code V2+（原生二进制）

Claude Code V2 以**原生二进制**分发（macOS Mach-O / Linux ELF / Windows PE），不再是 Node.js 脚本。原有 `node --require interceptor claude` 方式已不可用。

| Claude Code 版本 | 二进制类型 | 拦截模式 |
|------------------|------------|----------|
| V1.x | Node.js 脚本 | 通过 `--require` 注入 `interceptor-loader.js` |
| **V2+** | 原生二进制 | 本地反向代理；重定向 `ANTHROPIC_BASE_URL` |

流程：

1. 在 `127.0.0.1` 启动本地 HTTP 反向代理
2. 通过 `ANTHROPIC_BASE_URL` 将 Claude Code 指向代理
3. 转发流量到真实上游（`~/.claude/settings.json` 或环境变量）
4. 实时写入 `.claude-trace/`

若 `~/.claude/settings.json` 已设置 `ANTHROPIC_BASE_URL`，会使用持久化配置 overlay（`~/.claude-trace/claude-config-overlay/`）：仅重写 `settings.json` 去掉该项，其余条目尽量通过符号链接指向原配置（Windows 目录用 junction，文件 symlink 失败则复制）。**单项链接失败不会阻断启动**，代理仍可用；跳过的条目仅在 `CLAUDE_TRACE_DEBUG=1` 时输出到 stderr。

### 第三方模型（CC-Switch 与自定义端点）

支持任何通过自定义 `ANTHROPIC_BASE_URL` 路由 Claude Code 的方案——[CC-Switch](https://github.com/farion1231/cc-switch)、LiteLLM、企业网关、自托管代理等。

```
Claude Code  →  claude-trace 代理（记录）  →  CC-Switch / 自定义端点  →  模型提供商
```

CC-Switch 示例：

```bash
# CC-Switch 写入 ~/.claude/settings.json 后：
claude-trace
```

手动指定上游：

```bash
export ANTHROPIC_BASE_URL="https://your-gateway.example.com"
claude-trace
```

注意事项：

- 上游需支持 **Anthropic Messages API**（`/v1/messages`），或使用能转换为该格式的网关
- API Key 及 settings 中的其他 `env` 项会保留——仅在本地覆盖 `ANTHROPIC_BASE_URL`
- HTML 日志会显示实际上游 URL 和每次请求的模型名

### 请求过滤（Claude）

**代理模式（V2+）：** 默认 `/v1/messages`；`--include-all-requests` 记录所有代理流量。

**拦截模式（V1，Node.js）：** 默认记录上下文中消息数 > 2 的 `/v1/messages`；`--include-all-requests` 记录所有 `api.anthropic.com` 请求。

---

## OpenCode（`opencode-trace`）

### 使用

```bash
# 启动 OpenCode TUI 并记录日志
opencode-trace

# 单次 prompt
opencode-trace --run-with run "Explain async/await"

# 指定模型
opencode-trace --run-with run -m my-deepseek/deepseek-v4-flash "Refactor this module"

# 从已有会话生成 HTML
opencode-trace --generate-html .opencode-trace/log-2025-01-01-12-00-00.jsonl

# 生成会话索引
opencode-trace --index

opencode-trace --help
```

日志路径：当前目录 `.opencode-trace/log-YYYY-MM-DD-HH-MM-SS.{jsonl,json,html}`。代理运行时错误追加写入 `.opencode-trace/proxy-errors.log`。

### 拦截原理

OpenCode 为原生二进制。`opencode-trace` 启动本地反向代理，并通过 `OPENCODE_CONFIG_CONTENT` 注入运行时配置覆盖——**不会修改原始 `opencode.json`**。

配置中所有 provider 的 `baseURL` 均指向本地代理。代理从请求体读取 `model` 字段，映射到对应 provider 与真实上游 URL，再转发请求。支持 **Anthropic**（`/v1/messages`）与 **OpenAI** 格式（`/v1/chat/completions`、`/v1/responses`，即 `@ai-sdk/openai-compatible` 与 `@ai-sdk/openai`）。

```
OpenCode  →  opencode-trace 代理（记录）  →  provider baseURL（DeepSeek、MiniMax 等）
```

配置读取顺序：

1. 环境变量 `OPENCODE_CONFIG`
2. `OPENCODE_CONFIG_DIR/opencode.json`
3. `~/.config/opencode/opencode.json`
4. 当前目录 `.opencode/opencode.json`

### 支持的 API 格式

| OpenCode `npm` 包 | API 格式 | 端点 | 对话视图标签 |
|-------------------|----------|------|--------------|
| `@ai-sdk/anthropic` | Anthropic Messages | `/v1/messages` | Anthropic Messages |
| `@ai-sdk/openai-compatible` | OpenAI Chat Completions | `/v1/chat/completions` | OpenAI Chat |
| `@ai-sdk/openai` | OpenAI Responses | `/v1/responses` | OpenAI Responses |

代理从请求体读取 `model` 字段，路由到对应 provider 的 `baseURL`。同一 provider 下可通过 per-model `npm` 混用 chat 与 responses API。未在 `opencode.json` 中显式声明的模型，可通过 provider 级回退路由（`providerId/*`）匹配。

### CLI 选项

| 参数 | 说明 |
|------|------|
| `--opencode-path PATH` | OpenCode 二进制路径（省略则自动检测） |
| `--include-all-requests` | 记录所有代理流量，不仅限于 messages 端点 |
| `--include-sensitive-headers` | 不脱敏记录 auth 头 |
| `--log NAME` | 自定义日志文件名 |
| `--no-open` | 不自动打开 HTML |
| `--run-with ARGS...` | 传递给 OpenCode 的参数 |

### 调试

默认情况下运行时日志**静默输出**，避免污染 OpenCode TUI 输入框。

| 输出内容 | 默认行为 | 设置 `OPENCODE_TRACE_DEBUG=1` 后 |
|----------|----------|----------------------------------|
| 每次请求路由（model → provider → 上游 URL） | 不输出 | 打印到 stderr |
| 代理错误（如上游 TLS 连接失败） | 写入 `.opencode-trace/proxy-errors.log` | 同时打印到 stderr |

```bash
OPENCODE_TRACE_DEBUG=1 opencode-trace
```

当模型未正确路由、日志缺少请求，或上游连接失败时，可使用此命令排查。

### OpenCode 当前限制

- **对话视图**支持 Anthropic 格式（`@ai-sdk/anthropic`）与 OpenAI 格式（`@ai-sdk/openai-compatible`、`@ai-sdk/openai`）provider；复杂字段（多模态、reasoning 等）可能仅在 Raw/JSON 视图中完整展示。
- 尚未拦截未在 `opencode.json` 中定义的内置 `models.dev` provider。

---

## Codex CLI（`codex-trace`）

**主要认证方式：ChatGPT OAuth。** 若你通过 ChatGPT 账号登录 Codex（多数安装的默认方式），`codex-trace` 可完整追踪该路径 —— 多轮对话、zstd 压缩请求与 SSE 流式响应均能在 HTML 报告中正确展示。

### 用法

```bash
# 启动 Codex TUI 并记录流量（支持 ChatGPT OAuth 或 API Key）
codex-trace

# 无头单次执行
codex-trace --run-with exec "Explain async/await"

# 从历史日志生成 HTML
codex-trace --generate-html .codex-trace/log-2025-01-01-12-00-00.jsonl

# 生成会话索引
codex-trace --index

codex-trace --help
```

日志路径：当前目录 `.codex-trace/log-YYYY-MM-DD-HH-MM-SS.{jsonl,json,html}`。

### ChatGPT OAuth 模式（推荐）

多数用户通过 **ChatGPT 登录** 使用 Codex（`codex login` 或 TUI 内登录）。`codex-trace` 读取 `~/.codex/auth.json`，当 `auth_mode` 为 `"chatgpt"` 时，将所有 LLM 流量路由到 ChatGPT OAuth 上游（`chatgpt.com/backend-api/codex`）——**即使 shell 中为其他工具设置了 `OPENAI_BASE_URL`**（如 Cursor、LiteLLM 等）也不受影响。

| 检查项 | 预期 |
|--------|------|
| 认证文件 | `~/.codex/auth.json` 含 `"auth_mode": "chatgpt"` |
| 会话数据 | 从真实 `$CODEX_HOME` symlink，OAuth token 不会被改写 |
| HTML 报告 | 多轮对话完整展示每条 assistant 回复，含最后一轮 |

```
Codex CLI（ChatGPT OAuth）  →  codex-trace 代理（记录）  →  chatgpt.com/backend-api/codex
```

**提示：** 请先完成 ChatGPT 登录，再启动 `codex-trace`。若在 trace 会话中途于 Codex 内切换认证方式，建议重新运行 `codex-trace`。

### OpenAI API Key 模式

若使用 **OpenAI API Key** 而非 ChatGPT 登录，流量经 `openai_base_url` / `OPENAI_BASE_URL` / `api.openai.com`（或自定义网关）路由。请勿将 ChatGPT OAuth token 与自定义 `OPENAI_BASE_URL` 网关混用 —— 同一时间只应使用一种认证方式。

### 拦截原理

Codex CLI 为 Rust 原生二进制。`codex-trace` 启动本地反向代理，并在 `~/.claude-trace/codex-config-overlay/` 构建配置覆盖层——**不会修改原始 `~/.codex/config.toml`**。

覆盖层将 `openai_base_url`、`chatgpt_base_url` 及自定义 `model_providers.*.base_url` 改写为代理地址。`auth.json` 与会话数据通过 symlink 保留，ChatGPT OAuth 可继续使用。代理根据 **`auth.json` 的 auth 模式**（ChatGPT OAuth 或 API Key）与请求路径选择上游：

- **ChatGPT OAuth**（`auth_mode: "chatgpt"`）：`/responses`、`/v1/responses`、`/backend-api/codex/...` → `chatgpt.com`
- **ChatGPT Apps MCP**（`codex_apps`）：`/api/codex/apps` → `chatgpt.com/backend-api/wham/apps`；`/backend-api/wham/...` → `chatgpt.com`（站点根路径）
- **OpenAI API Key**：`/v1/responses`、`/responses` → `openai_base_url` / `OPENAI_BASE_URL` / 默认 OpenAI 主机
- **自定义 `model_providers`**：非保留 provider id 且配置了 `base_url` 的条目

```
Codex CLI  →  codex-trace 代理（记录）  →  chatgpt.com（OAuth）/ api.openai.com / 自定义 provider
```

配置查找：`CODEX_HOME`（覆盖层）或 `~/.codex/config.toml`。

### CLI 选项

| 参数 | 说明 |
|------|------|
| `--codex-path PATH` | Codex 二进制路径（省略则自动检测） |
| `--include-all-requests` | 记录所有代理流量，不仅限于 LLM API 路径 |
| `--include-sensitive-headers` | 不脱敏记录认证头 |
| `--log NAME` | 自定义日志文件名前缀 |
| `--no-open` | 不自动打开 HTML |
| `--run-with ARGS...` | 将后续参数传给 Codex |

### Codex 限制

- 覆盖层强制 `supports_websockets = false`，确保 HTTP/SSE 流量可被记录。
- 内置 provider ID（`openai`、`ollama`、`lmstudio`）不能通过 `model_providers` 覆盖；ChatGPT OAuth 使用 `chatgpt_base_url`，API Key 模式使用 `openai_base_url`。
- **Ollama / LM Studio** 内置 provider 不会被拦截（流量绕过代理）。
- 旧版 `auth.json` 若无 `auth_mode` 字段，会回退到旧启发式；若 OAuth 路由异常，请重新用 ChatGPT 登录。
- **Node.js：** Codex ChatGPT OAuth 追踪在 **Node.js 16+** 即可正常使用（代理原样转发 zstd 请求体）。建议 **Node.js 22+**，以便在日志与 HTML 中解压展示 zstd 压缩的请求体；Node 16–21 下请求条目会显示占位符而非解析后的 JSON（响应解析与代理行为不受影响）。

---

## 共用功能

### HTML 报告

每次会话生成自包含 HTML 文件（内嵌 CSS/JS），可离线打开。退出时默认自动打开浏览器，可用 `--no-open` 关闭。

### 你将看到的内容

- **系统提示词** — 发送给模型的隐藏指令
- **工具定义与输出** — 参数及原始工具结果
- **思考块** — 内部推理过程（如有）
- **Token 用量** — 含缓存命中的详细统计
- **原始 JSONL 日志** — 完整请求/响应对
- **交互式查看器** — 对话、原始 HTTP、JSON 调试等视图
- **API 格式标签** — 每个会话头部显示请求格式（如 `8 messages · OpenAI Chat`）

### 会话索引

```bash
claude-trace --index
# 或
opencode-trace --index
# 或
codex-trace --index
```

扫描日志文件，通过 Claude CLI 为有意义会话生成摘要，并输出可搜索的 `index.html`。**注意：** 索引会产生额外 API token 消耗。

## 环境要求

- Node.js 16+（Codex OAuth 请求体完整日志展示建议 Node.js 22+）
- **Claude Code** CLI（V1 Node.js 或 V2+ 原生二进制），用于 `claude-trace`
- **OpenCode** CLI，用于 `opencode-trace`
- **Codex CLI**，用于 `codex-trace`

## 开发

```bash
npm run setup    # 首次安装
npm run dev      # watch 模式；预览 http://localhost:8080/test
npm run build
npm run typecheck
npm run test:unit
```

### 架构

**后端**（`src/`）：

- **CLI**（`cli/cli.ts`、`cli/opencode-cli.ts`、`cli/codex-cli.ts`、`cli/cli-common.ts`）— 薄入口与共用参数解析
- **Trace Runner**（`cli/trace-runner.ts`）— 通用启动与代理/拦截器分发
- **Tool Profiles**（`tools/claude.ts`、`tools/opencode.ts`、`tools/codex.ts`、`tools/binary-utils.ts`）— 各工具配置、二进制检测、上游解析
- **Config Overlays**（`config/claude-config-overlay.ts`、`config/codex-config-overlay.ts`）— 持久化代理覆盖层，不修改用户原始配置
- **Reverse Proxy**（`intercept/reverse-proxy.ts`）— 原生二进制拦截，实时 HTML 生成
- **Interceptor**（`intercept/interceptor.ts`）+ **Loader**（`intercept/interceptor-loader.js`、`intercept/token-extractor.js`）— Claude Code V1
- **Routing**（`routing/proxy-routing.ts`、`routing/codex-routing.ts`）— OpenCode 模型路由与 Codex 路径/auth 上游选择
- **API Format**（`adapt/api-format.ts`）— 格式检测与展示标签
- **OpenAI Adapter**（`adapt/openai-adapter.ts`）— OpenAI 请求/响应适配为 Anthropic `Message`，供查看器展示
- **Report**（`report/html-generator.ts`、`report/index-generator.ts`、`report/shared-conversation-processor.ts`）— HTML 生成与会话解析

**前端**（`frontend/src/`）：Lit + Tailwind 交互查看器，嵌入 HTML 报告。

## 许可证

MIT — 原作者 [Mario Zechner](https://github.com/badlogic/lemmy/tree/main/apps/claude-trace)，由 [@hanqunfeng/claude-trace](https://github.com/hanqunfeng/claude-trace) 维护。
