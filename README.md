# claude-trace

[English](README.md) | [简体中文](README.zh-CN.md)

Record API traffic from **Claude Code**, **OpenCode**, **Codex CLI**, and allowlisted LLM endpoints through a standalone forward proxy. Inspect everything the tools hide — system prompts, tool outputs, thinking blocks, and raw request/response data — in a self-contained HTML viewer.

**Fork of [mariozechner/claude-trace](https://github.com/badlogic/lemmy/tree/main/apps/claude-trace)**, extended with [Claude Code V2+](https://docs.anthropic.com/en/docs/claude-code) native-binary support, a dedicated **[OpenCode](https://opencode.ai)** CLI with multi-provider interception (Anthropic and OpenAI API formats), and **[Codex CLI](https://developers.openai.com/codex/cli) ChatGPT OAuth** tracing (login via ChatGPT account — the default Codex auth path for most users).

## Proxy modes (forward & reverse)

This project supports **both**:

- **Reverse proxy (built-in tool wrappers)**: `claude-trace`, `opencode-trace`, `codex-trace` start a local reverse proxy and launch the target tool with its upstream base URL redirected to the proxy (so traffic is logged automatically).
- **Forward proxy (standalone)**: `vibe-coding-proxy` starts an HTTP/HTTPS forward proxy only. You must **export `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` before starting the client** you want to trace.

## Supported tools

| Tool | CLI command | Log directory | Interception |
|------|-------------|---------------|--------------|
| **Claude Code** | `claude-trace` | `.claude-trace/` | V1: Node.js `fetch()` hook · V2+: reverse proxy via `ANTHROPIC_BASE_URL` |
| **OpenCode** | `opencode-trace` | `.opencode-trace/` | Reverse proxy + model routing; Anthropic & OpenAI API formats |
| **Codex CLI** | `codex-trace` | `.codex-trace/` | Reverse proxy via `CODEX_HOME` overlay; **ChatGPT OAuth** & OpenAI API Key (Responses API) |
| **Standalone proxy** | `vibe-coding-proxy` | `.vibe-coding-proxy/` | Forward proxy via `HTTP_PROXY` / `HTTPS_PROXY`; allowlist-scoped HTTPS MITM |

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

# Standalone forward proxy
vibe-coding-proxy --target-url https://api.deepseek.com/anthropic
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
npm link        # optional: global `claude-trace`, `opencode-trace`, `codex-trace`, and `vibe-coding-proxy`
# Without link: node dist/cli/cli.js / node dist/cli/opencode-cli.js / node dist/cli/codex-cli.js / node dist/cli/vibe-coding-proxy-cli.js
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

**Primary auth mode: ChatGPT OAuth.** If you use Codex signed in with your ChatGPT account (the default for most installs), `codex-trace` fully supports tracing that path — multi-turn conversations, zstd-compressed requests, and SSE streaming responses appear correctly in HTML reports.

### Usage

```bash
# Start Codex TUI with logging (ChatGPT OAuth or API Key)
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

### ChatGPT OAuth mode (recommended)

Most users run Codex with **ChatGPT login** (`codex login` or the TUI sign-in flow). `codex-trace` reads `~/.codex/auth.json` and, when `auth_mode` is `"chatgpt"`, routes all LLM traffic to the ChatGPT OAuth upstream (`chatgpt.com/backend-api/codex`) — **even if `OPENAI_BASE_URL` is set in your shell** for other tools (Cursor, LiteLLM, etc.).

| Check | Expected |
|-------|----------|
| Auth file | `~/.codex/auth.json` contains `"auth_mode": "chatgpt"` |
| Session data | Symlinked from your real `$CODEX_HOME`; OAuth tokens are not rewritten |
| HTML report | Multi-turn threads show each assistant reply, including the final turn |

```
Codex CLI (ChatGPT OAuth)  →  codex-trace proxy (logs)  →  chatgpt.com/backend-api/codex
```

**Tip:** Log in to Codex with ChatGPT *before* starting `codex-trace`. Switching auth inside Codex without restarting the trace session may require a fresh `codex-trace` run.

### OpenAI API Key mode

If you use Codex with an **OpenAI API Key** instead of ChatGPT login, traffic is routed via `openai_base_url` / `OPENAI_BASE_URL` / `api.openai.com` (or your custom gateway). Do not mix ChatGPT OAuth tokens with a custom `OPENAI_BASE_URL` gateway — use one auth mode at a time.

### How interception works

Codex CLI is a native Rust binary. `codex-trace` starts a local reverse proxy and builds a config overlay at `~/.claude-trace/codex-config-overlay/` — **your original `~/.codex/config.toml` is never modified**.

The overlay rewrites `openai_base_url`, `chatgpt_base_url`, and custom `model_providers.*.base_url` to point at the proxy. `auth.json` and session data are symlinked so ChatGPT OAuth continues to work. The proxy picks the upstream from **`auth.json` auth mode** (ChatGPT OAuth vs API Key) and request path:

- **ChatGPT OAuth** (`auth_mode: "chatgpt"`): `/responses`, `/v1/responses`, `/backend-api/codex/...` → `chatgpt.com`
- **ChatGPT Apps MCP** (`codex_apps`): `/api/codex/apps` → `chatgpt.com/backend-api/wham/apps`; `/backend-api/wham/...` → `chatgpt.com` (site origin)
- **OpenAI API Key**: `/v1/responses`, `/responses` → `openai_base_url` / `OPENAI_BASE_URL` / default OpenAI host
- **Custom `model_providers`**: non-reserved provider IDs with explicit `base_url`

```
Codex CLI  →  codex-trace proxy (logs)  →  chatgpt.com (OAuth) / api.openai.com / custom provider
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
- Built-in provider IDs (`openai`, `ollama`, `lmstudio`) cannot be overridden via `model_providers`; ChatGPT OAuth uses `chatgpt_base_url`, API Key mode uses `openai_base_url`.
- **Ollama / LM Studio** built-in providers are not intercepted (traffic bypasses the proxy).
- Older `auth.json` files without `auth_mode` fall back to legacy heuristics; re-login with ChatGPT if OAuth routing misbehaves.
- **Node.js:** Codex ChatGPT OAuth tracing works on **Node.js 16+** (the proxy forwards zstd request bodies unchanged). **Node.js 22+** is recommended so zstd-compressed request bodies are decompressed in logs and HTML; on Node 16–21, request entries show a placeholder instead of parsed JSON (responses and proxy behavior are unaffected).

---

## Standalone forward proxy (`vibe-coding-proxy`)

`vibe-coding-proxy` starts only the proxy service. It does not spawn Claude Code, OpenCode, Codex, or any other client. Point any compatible CLI at the printed proxy URL with `HTTP_PROXY`, `HTTPS_PROXY`, or `ALL_PROXY`.

### Compatibility & usage order

- **Tested clients**: Claude Code, OpenCode, Codex CLI. Other clients may work if they respect standard proxy env vars, but are not tested yet.
- **Order matters**: start `vibe-coding-proxy` → export env vars in the same shell/session → then start your client/tool. If you start the client first, it may not pick up the proxy settings.

### Usage

```bash
# Log a specific DeepSeek Anthropic-compatible endpoint
vibe-coding-proxy --target-url https://api.deepseek.com/anthropic

# Log every HTTPS request on a host
vibe-coding-proxy --mitm-host api.deepseek.com

# Use a fixed local port
vibe-coding-proxy --target-url https://api.deepseek.com --port 8888

# Generate HTML from a previous .jsonl log
vibe-coding-proxy --generate-html .vibe-coding-proxy/log-2025-01-01-12-00-00.jsonl
```

After startup, export the printed proxy URL:

```bash
export HTTP_PROXY=http://127.0.0.1:PORT
export HTTPS_PROXY=http://127.0.0.1:PORT
export ALL_PROXY=http://127.0.0.1:PORT
export NODE_TLS_REJECT_UNAUTHORIZED=0
export SSL_CERT_FILE=CA_CERT_PATH
```

Logs: `.vibe-coding-proxy/log-YYYY-MM-DD-HH-MM-SS.{jsonl,json,html}` in the current directory.

### HTTPS logging and CA trust

HTTPS requests sent through `HTTPS_PROXY` normally use `CONNECT host:443`, which hides JSON bodies from the proxy. To log request/response bodies, `vibe-coding-proxy` performs MITM only for `--target-url` / `--mitm-host` allowlist entries and prints a local CA certificate path.

Trust that CA only in clients whose model traffic you want to inspect. The command never installs the CA into your system trust store automatically. `NODE_TLS_REJECT_UNAUTHORIZED=0` only helps Node.js clients; Codex ChatGPT OAuth is a Rust client and may require `SSL_CERT_FILE` or OS-level trust for the printed CA. Non-allowlisted HTTPS traffic is passed through as a raw CONNECT tunnel and only logged as metadata when `--include-all-requests` is enabled.

### Local CA lifecycle

The local CA is reused across proxy runs from `~/.claude-trace/vibe-coding-proxy-ca/` unless you pass `--ca-dir`. `ca.crt` is valid for 10 years; per-host leaf certificates such as `api.deepseek.com.crt.pem` are valid for 1 year. Expired leaf certificates are reissued automatically. If the CA expires, it is regenerated and all cached leaf certificates are removed; you must trust the new CA again.


### CLI options

| Flag | Description |
|------|-------------|
| `--target-url URL` | URL prefix to decrypt and fully log (repeatable) |
| `--mitm-host HOST` | Hostname to decrypt and fully log (repeatable) |
| `--host HOST` | Listen host (default `127.0.0.1`) |
| `--port PORT` | Listen port (default `0`, random) |
| `--log-dir DIR` | Log directory (default `.vibe-coding-proxy`) |
| `--log NAME` | Custom log file base name |
| `--ca-dir DIR` | Local CA and leaf certificate cache directory |
| `--no-mitm` | Disable TLS MITM; HTTPS CONNECT is pass-through only |
| `--include-all-requests` | Log pass-through CONNECT metadata and non-target HTTP traffic |
| `--include-sensitive-headers` | Log auth headers without redaction |
| `--no-open` | Don't open generated HTML on exit |
| `--generate-html FILE [OUT]` | Generate HTML report from JSONL |

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

- Node.js 16+ (Node.js 22+ recommended for full Codex OAuth request-body display in logs)
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

- **CLI** (`cli/cli.ts`, `cli/opencode-cli.ts`, `cli/codex-cli.ts`, `cli/cli-common.ts`) — thin entry points and shared arg parsing
- **Trace Runner** (`cli/trace-runner.ts`) — shared launch + proxy/interceptor dispatch
- **Tool Profiles** (`tools/claude.ts`, `tools/opencode.ts`, `tools/codex.ts`, `tools/binary-utils.ts`) — per-tool config, binary detection, upstream resolution
- **Config Overlays** (`config/claude-config-overlay.ts`, `config/codex-config-overlay.ts`) — persistent proxy overlays without modifying user config
- **Reverse Proxy** (`intercept/reverse-proxy.ts`) — native-binary interception, real-time HTML generation
- **Interceptor** (`intercept/interceptor.ts`) + **Loader** (`intercept/interceptor-loader.js`, `intercept/token-extractor.js`) — Claude Code V1
- **Routing** (`routing/proxy-routing.ts`, `routing/codex-routing.ts`) — OpenCode model routes and Codex path/auth upstream selection
- **API Format** (`adapt/api-format.ts`) — format detection and display labels
- **OpenAI Adapter** (`adapt/openai-adapter.ts`) — OpenAI request/response → Anthropic `Message` for the viewer
- **Report** (`report/html-generator.ts`, `report/index-generator.ts`, `report/shared-conversation-processor.ts`) — HTML generation and shared conversation parsing

**Frontend** (`frontend/src/`): Lit + Tailwind interactive viewer embedded into HTML reports.

## License

MIT — originally by [Mario Zechner](https://github.com/badlogic/lemmy/tree/main/apps/claude-trace), maintained as [@hanqunfeng/claude-trace](https://github.com/hanqunfeng/claude-trace).
