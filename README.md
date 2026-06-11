# claude-trace

[English](README.md) | [简体中文](README.zh-CN.md)

Record API traffic from **Claude Code**, **OpenCode**, and **Codex CLI** while you work. Inspect everything the tools hide — system prompts, tool outputs, thinking blocks, and raw request/response data — in a self-contained HTML viewer.

**Fork of [mariozechner/claude-trace](https://github.com/badlogic/lemmy/tree/main/apps/claude-trace)**, extended with [Claude Code V2+](https://docs.anthropic.com/en/docs/claude-code) native-binary support and a dedicated **[OpenCode](https://opencode.ai)** CLI with multi-provider interception (Anthropic and OpenAI API formats).

## Supported tools

| Tool | CLI command | Log directory | Interception |
|------|-------------|---------------|--------------|
| **Claude Code** | `claude-trace` | `.claude-trace/` | V1: Node.js `fetch()` hook · V2+: reverse proxy via `ANTHROPIC_BASE_URL` |
| **OpenCode** | `opencode-trace` | `.opencode-trace/` | Reverse proxy + model routing; Anthropic & OpenAI API formats |
| **Codex CLI** | `codex-trace` | `.codex-trace/` | Reverse proxy via `CODEX_HOME` overlay; OpenAI Responses API |

All commands share the same HTML report UI, JSONL/JSON export, and `--index` conversation summarization.

## Quick start

```bash
npm install -g @hanqunfeng/claude-trace

# Claude Code
claude-trace

# OpenCode
opencode-trace

# Codex CLI
codex-trace
```

When a session ends, the latest HTML report opens in your browser automatically (disable with `--no-open`).

## Install

### From npm

```bash
npm install -g @hanqunfeng/claude-trace
```

### From source

```bash
git clone https://github.com/hanqunfeng/claude-trace.git
cd claude-trace
npm run setup   # installs root + frontend dependencies
npm run build
npm link        # optional: global `claude-trace`, `opencode-trace`, and `codex-trace`
# Without link: node dist/cli/cli.js / node dist/cli/opencode-cli.js / node dist/cli/codex-cli.js
```

## Claude Code (`claude-trace`)

### Usage

```bash
# Start Claude Code with logging (auto-detects V1 JS vs V2+ native binary)
claude-trace

# Include all API requests (proxy mode defaults to /v1/messages only)
claude-trace --include-all-requests

# Log auth headers without redaction (use with care)
claude-trace --include-sensitive-headers

# Pass arguments to Claude
claude-trace --run-with chat --model sonnet-3.5

# Custom Claude binary path
claude-trace --claude-path /usr/local/Caskroom/claude-code/2.1.153/claude

# Extract OAuth token (V1 Node.js path)
claude-trace --extract-token

# Generate HTML from a previous .jsonl log
claude-trace --generate-html logs.jsonl report.html

# Generate conversation summaries and searchable index
claude-trace --index

claude-trace --help
```

Logs: `.claude-trace/log-YYYY-MM-DD-HH-MM-SS.{jsonl,json,html}` in the current directory.

### CLI options

| Flag | Description |
|------|-------------|
| `--include-all-requests` | Log all API traffic, not just `/v1/messages` |
| `--include-sensitive-headers` | Log auth tokens and cookies without redaction |
| `--log NAME` | Custom log file base name (without extension) |
| `--claude-path PATH` | Path to Claude binary (auto-detected if omitted) |
| `--no-open` | Don't open generated HTML in browser |
| `--run-with ARGS...` | Pass remaining arguments to Claude |
| `--extract-token` | Extract OAuth token and exit |
| `--generate-html FILE [OUT]` | Generate HTML report from JSONL |
| `--index` | Generate conversation summaries and index |

### Claude Code V2+ (native binary)

Claude Code V2 ships as a **native binary** (Mach-O / ELF / PE), not a Node.js script. The original `node --require interceptor claude` approach no longer works.

| Claude Code version | Binary type | Interception mode |
|---------------------|-------------|-------------------|
| V1.x | Node.js script | `interceptor-loader.js` via `--require` |
| **V2+** | Native binary | Local reverse proxy; `ANTHROPIC_BASE_URL` redirected |

Flow:

1. Start a local HTTP reverse proxy on `127.0.0.1`
2. Point Claude Code at the proxy via `ANTHROPIC_BASE_URL`
3. Forward traffic to the real upstream (`~/.claude/settings.json` or env)
4. Log request/response pairs to `.claude-trace/` in real time

If `~/.claude/settings.json` already sets `ANTHROPIC_BASE_URL`, a persistent config overlay is used (`~/.claude-trace/claude-config-overlay/`): only `settings.json` is rewritten without that key; other entries are symlinked back to your real config when possible (directory **junctions** on Windows; files fall back to copy). **A failed link for one entry does not block startup** — the proxy still works. Skipped entries are logged only when `CLAUDE_TRACE_DEBUG=1`.

### Third-party models (CC-Switch & custom endpoints)

Works with any setup that routes Claude Code through a custom `ANTHROPIC_BASE_URL` — [CC-Switch](https://github.com/farion1231/cc-switch), LiteLLM, corporate gateways, self-hosted proxies, etc.

```
Claude Code  →  claude-trace proxy (logs)  →  CC-Switch / custom endpoint  →  model provider
```

Example with CC-Switch:

```bash
# CC-Switch writes ~/.claude/settings.json; then:
claude-trace
```

Manual upstream:

```bash
export ANTHROPIC_BASE_URL="https://your-gateway.example.com"
claude-trace
```

Notes:

- Upstream must speak the **Anthropic Messages API** (`/v1/messages`), or use a gateway that translates to it
- API keys and other `env` entries from settings are preserved — only `ANTHROPIC_BASE_URL` is overridden locally
- HTML logs show the actual upstream URL and model name per request

### Request filtering (Claude)

**Proxy mode (V2+):** default `/v1/messages`; `--include-all-requests` logs all proxied traffic.

**Interceptor mode (V1, Node.js):** default logs `/v1/messages` with more than 2 messages in context; `--include-all-requests` logs all `api.anthropic.com` requests.

---

## OpenCode (`opencode-trace`)

### Usage

```bash
# Start OpenCode TUI with logging
opencode-trace

# One-shot prompt
opencode-trace --run-with run "Explain async/await"

# Specific model
opencode-trace --run-with run -m my-deepseek/deepseek-v4-flash "Refactor this module"

# Generate HTML from a previous session
opencode-trace --generate-html .opencode-trace/log-2025-01-01-12-00-00.jsonl

# Conversation index
opencode-trace --index

opencode-trace --help
```

Logs: `.opencode-trace/log-YYYY-MM-DD-HH-MM-SS.{jsonl,json,html}` in the current directory. Proxy runtime errors are appended to `.opencode-trace/proxy-errors.log`.

### How interception works

OpenCode is a native binary. `opencode-trace` starts a local reverse proxy and injects a runtime config override via `OPENCODE_CONFIG_CONTENT` — **your original `opencode.json` is never modified**.

For every provider in your config, all `baseURL` values point at the local proxy. The proxy reads the `model` field from each request body, maps it to the correct provider and real upstream URL, then forwards the request. Supports **Anthropic** (`/v1/messages`) and **OpenAI** formats (`/v1/chat/completions`, `/v1/responses` via `@ai-sdk/openai-compatible` and `@ai-sdk/openai`).

```
OpenCode  →  opencode-trace proxy (logs)  →  provider baseURL (DeepSeek, MiniMax, etc.)
```

Config lookup order:

1. `OPENCODE_CONFIG` environment variable
2. `OPENCODE_CONFIG_DIR/opencode.json`
3. `~/.config/opencode/opencode.json`
4. `.opencode/opencode.json` in the current directory

### Supported API formats

| OpenCode `npm` package | API format | Endpoints | Conversation view label |
|------------------------|------------|-----------|-------------------------|
| `@ai-sdk/anthropic` | Anthropic Messages | `/v1/messages` | Anthropic Messages |
| `@ai-sdk/openai-compatible` | OpenAI Chat Completions | `/v1/chat/completions` | OpenAI Chat |
| `@ai-sdk/openai` | OpenAI Responses | `/v1/responses` | OpenAI Responses |

The proxy reads `model` from each request body and routes to the matching provider `baseURL`. Per-model `npm` overrides are supported when a single provider mixes chat and responses APIs. Provider-level fallback (`providerId/*`) handles models not explicitly listed in `opencode.json`.

### CLI options

| Flag | Description |
|------|-------------|
| `--opencode-path PATH` | Path to OpenCode binary (auto-detected if omitted) |
| `--include-all-requests` | Log all proxied API traffic, not just message endpoints |
| `--include-sensitive-headers` | Log auth tokens without redaction |
| `--log NAME` | Custom log file base name |
| `--no-open` | Don't open generated HTML in browser |
| `--run-with ARGS...` | Pass remaining arguments to OpenCode |

### Debugging

By default, runtime logs are **silent** so they do not pollute OpenCode's TUI input area.

| Output | Default | With `OPENCODE_TRACE_DEBUG=1` |
|--------|---------|-------------------------------|
| Per-request routing (model → provider → upstream) | Hidden | Printed to stderr |
| Proxy errors (e.g. upstream TLS failure) | Written to `.opencode-trace/proxy-errors.log` | Also printed to stderr |

```bash
OPENCODE_TRACE_DEBUG=1 opencode-trace
```

Use this when a model is not routed correctly, requests are missing from the log, or upstream connections fail.

### OpenCode limitations

- **Conversation view** supports Anthropic-format (`@ai-sdk/anthropic`) and OpenAI-format (`@ai-sdk/openai-compatible`, `@ai-sdk/openai`) providers; complex fields (multimodal, reasoning, etc.) may only appear fully in Raw/JSON views.
- Built-in `models.dev` providers not defined in your `opencode.json` are not intercepted yet.

---

## Codex CLI (`codex-trace`)

### Usage

```bash
# Start Codex TUI with logging
codex-trace

# One-shot headless prompt
codex-trace --run-with exec "Explain async/await"

# Generate HTML from a previous session
codex-trace --generate-html .codex-trace/log-2025-01-01-12-00-00.jsonl

# Conversation index
codex-trace --index

codex-trace --help
```

Logs: `.codex-trace/log-YYYY-MM-DD-HH-MM-SS.{jsonl,json,html}` in the current directory.

### How interception works

Codex CLI is a native Rust binary. `codex-trace` starts a local reverse proxy and builds a config overlay at `~/.claude-trace/codex-config-overlay/` — **your original `~/.codex/config.toml` is never modified**.

The overlay rewrites `openai_base_url`, `chatgpt_base_url`, and custom `model_providers.*.base_url` to point at the proxy. `auth.json` and session data are symlinked so ChatGPT OAuth continues to work. The proxy routes by request path:

- `/v1/responses`, `/responses`, `/responses/compact` → OpenAI API Key or custom provider upstream
- `/backend-api/codex/responses` → ChatGPT OAuth upstream

```
Codex CLI  →  codex-trace proxy (logs)  →  api.openai.com / chatgpt.com / custom provider
```

Config lookup: `CODEX_HOME` (overlay) or `~/.codex/config.toml`.

### CLI options

| Flag | Description |
|------|-------------|
| `--codex-path PATH` | Path to Codex binary (auto-detected if omitted) |
| `--include-all-requests` | Log all proxied API traffic, not just LLM API paths |
| `--include-sensitive-headers` | Log auth tokens without redaction |
| `--log NAME` | Custom log file base name |
| `--no-open` | Don't open generated HTML in browser |
| `--run-with ARGS...` | Pass remaining arguments to Codex |

### Codex limitations

- WebSocket Responses transport is disabled in the overlay (`supports_websockets = false`) so HTTP/SSE traffic can be logged.
- Built-in provider IDs (`openai`, `ollama`, `lmstudio`) cannot be overridden via `model_providers`; interception uses `openai_base_url` / `chatgpt_base_url` instead.

---

## Shared features

### HTML report

Each session produces a self-contained HTML file (embedded CSS/JS) you can open offline. On exit, the browser opens automatically unless you pass `--no-open`.

### What you'll see

- **System prompts** — hidden instructions sent to the model
- **Tool definitions & outputs** — parameters and raw tool results
- **Thinking blocks** — internal reasoning (when present)
- **Token usage** — detailed breakdown including cache hits
- **Raw JSONL logs** — complete request/response pairs
- **Interactive viewer** — conversation, raw HTTP, and JSON debug tabs
- **API format label** — each conversation shows its request format (e.g. `8 messages · OpenAI Chat`) in the session header

### Conversation index

```bash
claude-trace --index
# or
opencode-trace --index
# or
codex-trace --index
```

Scans log files, summarizes meaningful conversations via Claude CLI, and generates a searchable `index.html`. **Note:** indexing uses additional API tokens.

## Requirements

- Node.js 16+
- **Claude Code** CLI (V1 Node.js or V2+ native binary) for `claude-trace`
- **OpenCode** CLI for `opencode-trace`
- **Codex CLI** for `codex-trace`

## Development

```bash
npm run setup    # first time
npm run dev      # watch mode; preview at http://localhost:8080/test
npm run build
npm run typecheck
npm run test:unit
```

### Architecture

**Backend** (`src/`):

- **CLI** (`cli.ts`, `opencode-cli.ts`, `codex-cli.ts`) — thin entry points
- **Trace Runner** (`trace-runner.ts`) — shared launch + proxy/interceptor dispatch
- **Tool Profiles** (`tools/claude.ts`, `tools/opencode.ts`, `tools/codex.ts`) — per-tool config, binary detection, upstream resolution
- **Reverse Proxy** (`reverse-proxy.ts`) — native-binary interception, real-time HTML generation
- **Proxy Routing** (`proxy-routing.ts`) — model route resolution and upstream path normalization
- **API Format** (`api-format.ts`) — format detection and display labels
- **OpenAI Adapter** (`openai-adapter.ts`) — OpenAI request/response → Anthropic `Message` for the viewer
- **Interceptor** (`interceptor.ts`) + **Loader** (`interceptor-loader.js`) — Claude Code V1
- **HTML Generator** (`html-generator.ts`), **Index Generator** (`index-generator.ts`), **Shared Conversation Processor** (`shared-conversation-processor.ts`)

**Frontend** (`frontend/src/`): Lit + Tailwind interactive viewer embedded into HTML reports.

## License

MIT — originally by [Mario Zechner](https://github.com/badlogic/lemmy/tree/main/apps/claude-trace), maintained as [@hanqunfeng/claude-trace](https://github.com/hanqunfeng/claude-trace).
