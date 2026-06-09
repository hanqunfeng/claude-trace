# claude-trace

[English](README.md) | [简体中文](README.zh-CN.md)

记录你与 Claude Code 的所有交互。以直观的 Web 界面查看 Claude 隐藏的内容：系统提示词、工具输出和原始 API 数据。

**[mariozechner/claude-trace](https://github.com/badlogic/lemmy/tree/main/apps/claude-trace) 的分支版本，完整支持 [Claude Code V2+](https://docs.anthropic.com/en/docs/claude-code)**（通过反向代理支持原生二进制）。

## Claude Code V2+ 支持

Claude Code V2 以**原生二进制**形式分发（macOS 为 Mach-O，Linux 为 ELF，Windows 为 PE），不再是 Node.js 脚本。原有的拦截方式（`node --require interceptor claude`）已无法使用。

本分支会自动检测二进制类型并选择对应的拦截策略：

| Claude Code 版本 | 二进制类型 | 拦截模式 |
|------------------|------------|----------|
| V1.x | Node.js 脚本 | 通过 `--require` 注入 `interceptor-loader.js` |
| **V2+** | 原生二进制 | 本地**反向代理**；重定向 `ANTHROPIC_BASE_URL` |

针对原生二进制，claude-trace 会：

1. 在 `127.0.0.1` 启动本地 HTTP 反向代理
2. 通过 `ANTHROPIC_BASE_URL` 将 Claude Code 指向该代理
3. 将流量转发到真实 API（读取 `~/.claude/settings.json` 或 `ANTHROPIC_BASE_URL` 环境变量）
4. 实时将请求/响应对写入 `.claude-trace/`

若 `~/.claude/settings.json` 中已设置 `ANTHROPIC_BASE_URL`，会使用临时配置目录，**不会修改原始 settings 文件**。

## 第三方模型（CC-Switch 与自定义端点）

claude-trace 不仅支持官方 Anthropic API，也支持**第三方模型提供商**。任何通过自定义 `ANTHROPIC_BASE_URL` 路由 Claude Code 的方案均可使用——包括 [CC-Switch](https://github.com/farion1231/cc-switch)、LiteLLM、企业网关和自托管代理。

### 工作原理

CC-Switch 等工具通过向 `~/.claude/settings.json` 写入 `ANTHROPIC_BASE_URL`（及 API Key）来配置 Claude Code。运行 `claude-trace` 时，反向代理会：

1. **读取** `~/.claude/settings.json` 或 `ANTHROPIC_BASE_URL` 环境变量中的上游地址
2. **启动** `127.0.0.1` 上的本地日志代理
3. **重定向** Claude Code 到本地代理（使用临时配置，**不修改**原始 `settings.json`）
4. **转发** 已记录的流量到真实上游（CC-Switch 本地代理、DeepSeek、OpenRouter、LiteLLM 等）

```
Claude Code  →  claude-trace 代理（记录日志）  →  CC-Switch / 自定义端点  →  模型提供商
```

启动时会显示解析出的上游地址，例如：

```
Upstream API: http://127.0.0.1:15721
Reverse proxy started at http://127.0.0.1:xxxxx
```

### 示例：CC-Switch

1. 安装并配置 [CC-Switch](https://github.com/farion1231/cc-switch)，选择你偏好的提供商（DeepSeek、OpenRouter、本地代理等）
2. 在 CC-Switch 中切换提供商——配置会写入 `~/.claude/settings.json`
3. 照常运行 claude-trace：

```bash
claude-trace
```

claude-trace 会自动识别 CC-Switch 端点，**无需额外参数**。

`~/.claude/settings.json` 示例（由 CC-Switch 管理）：

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:15721",
    "ANTHROPIC_API_KEY": "sk-..."
  }
}
```

### 其他自定义端点

也可手动设置上游：

```bash
# 通过环境变量
export ANTHROPIC_BASE_URL="https://your-gateway.example.com"
claude-trace

# 或直接编辑 ~/.claude/settings.json
```

### 注意事项

- 上游需支持 **Anthropic Messages API**（`/v1/messages`），或使用 CC-Switch、LiteLLM 等能转换为该格式的网关
- API Key 及 settings 中的其他 `env` 项会保留——仅在本地将 `ANTHROPIC_BASE_URL` 覆盖为日志代理地址
- 若网关使用非标准路径，可用 `--include-all-requests` 捕获更多请求
- HTML 日志会显示实际上游 URL 和每次请求的模型名，便于确认会话使用的提供商

## 安装

### 从 npm 安装

```bash
npm install -g @hanqunfeng/claude-trace
```

### 从源码安装

```bash
git clone https://github.com/hanqunfeng/claude-trace.git
cd claude-trace
npm run setup  # 安装根目录 + frontend 依赖
npm run build
npm link       # 可选：全局可用 claude-trace 命令
```

## 使用

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

# 查看帮助
claude-trace --help

# 提取 OAuth token
claude-trace --extract-token

# 从已有 .jsonl 生成 HTML 报告
claude-trace --generate-html logs.jsonl report.html

# 生成 HTML 并包含所有请求
claude-trace --generate-html logs.jsonl --include-all-requests

# 生成会话摘要与可搜索索引
claude-trace --index
```

日志保存在当前目录的 `.claude-trace/log-YYYY-MM-DD-HH-MM-SS.{jsonl,json,html}`。HTML 文件自包含，可在任意浏览器中打开，无需服务器。

## CLI 选项

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

## 请求过滤

**代理模式（Claude Code V2+）：**

- **默认**：记录 `/v1/messages` 请求
- **`--include-all-requests`**：记录所有经代理的 API 流量

**拦截模式（Claude Code V1，Node.js）：**

- **默认**：记录上下文中消息数大于 2 的 `/v1/messages` 请求
- **`--include-all-requests`**：记录所有 `api.anthropic.com` 请求

## 会话索引

为编码会话生成 AI 摘要：

```bash
claude-trace --index
```

功能说明：

- 扫描 `.claude-trace/` 下所有 `.jsonl` 日志
- 过滤有意义的会话（消息数 > 2、未压缩）
- 调用 Claude CLI 为每个会话生成标题和摘要
- 创建 `summary-YYYY-MM-DD-HH-MM-SS.json` 元数据文件
- 生成按时间排序的 `index.html` 主索引
- 链接到各会话的 HTML 文件

**注意：** 索引会调用 Claude API，产生额外 token 消耗。

## 你将看到的内容

- **系统提示词** — Claude 收到的隐藏指令
- **工具定义** — 可用工具的描述与参数
- **工具输出** — 文件读取、搜索、API 调用的原始数据
- **思考块** — Claude 内部推理过程
- **Token 用量** — 含缓存命中的详细统计
- **原始 JSONL 日志** — 完整请求/响应对，便于分析
- **交互式 HTML 查看器** — 按模型筛选浏览会话
- **调试视图** — 原始 HTTP 流量；JSON 调试视图
- **会话索引** — AI 生成的摘要与可搜索索引

## 环境要求

- Node.js 16+
- 已安装 Claude Code CLI（V1 Node.js 或 **V2+ 原生二进制**）

## 开发

### 开发模式

```bash
npm run setup    # 首次：安装根目录 + frontend 依赖
npm run dev      # predev 编译并复制 JS loader，然后启动 watch
```

开发模式会 watch 编译主应用（`src/`）和前端（`frontend/src/`）。打开 `http://localhost:8080/test` 可预览 HTML 查看器与示例数据。

### 测试 CLI

```bash
npm run build
node dist/cli.js
npm run typecheck
```

### 构建

```bash
npm run build
```

**构建产物：**

- `dist/` — 编译后的 CLI、拦截器与反向代理
- `frontend/dist/` — 打包后的 Web 界面（CSS + JS）
- 自包含 HTML 报告（内嵌 CSS/JS）

### 架构

**双拦截模式的两部分系统：**

1. **后端**（`src/`）

   - **CLI**（`cli.ts`）— 检测原生/Node.js 二进制，启动对应拦截模式
   - **反向代理**（`reverse-proxy.ts`）— **Claude Code V2+**：本地 HTTP 代理，记录流量并实时生成 HTML
   - **拦截器**（`interceptor.ts`）— **Claude Code V1**：在 Node.js 进程中 hook `fetch()`
   - **拦截器加载器**（`interceptor-loader.js`）— V1 的 `--require` 钩子
   - **HTML 生成器**（`html-generator.ts`）— 将前端嵌入自包含 HTML 报告
   - **索引生成器**（`index-generator.ts`）— AI 会话摘要与可搜索索引
   - **共享会话处理器**（`shared-conversation-processor.ts`）— 前后端共用的解析逻辑
   - **Token 提取器**（`token-extractor.js`）— 提取 OAuth token（V1 Node.js 路径）

2. **前端**（`frontend/src/`）

   - **`app.ts`** — 主组件，数据处理与视图切换
   - **`index.ts`** — 应用入口
   - **`components/simple-conversation-view.ts`** — 会话展示与工具可视化
   - **`components/raw-pairs-view.ts`** — 原始 HTTP 流量查看器
   - **`components/json-view.ts`** — JSON 调试视图
   - **`styles.css`** — Tailwind CSS，VS Code 主题变量

## 许可证

MIT — 原作者 [Mario Zechner](https://github.com/badlogic/lemmy/tree/main/apps/claude-trace)，由 [@hanqunfeng/claude-trace](https://github.com/hanqunfeng/claude-trace) 维护。
