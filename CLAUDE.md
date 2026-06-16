# claude-trace — AI Assistant Guide

Read `README.md` at the start of a session for user-facing usage, troubleshooting, and flag tables.

**Doc hierarchy:** this file = agent invariants + architecture map + file touch guide + **code comment standards**. `README.md` = full CLI docs. When adding a flag or env var, update both (one line here, full table in README).

## Agent Invariants

- **Never** spawn Claude V2+ with `node --require interceptor` — use the reverse-proxy path.
- Edit **`src/` only**; rebuild before running `dist/`. `fix/` is reference only.
- After interception, routing, HTML, or parsing changes: `npm run typecheck && npm run test:unit && npm run build`.
- Do **not** enable `--include-sensitive-headers` in examples unless explicitly requested (logs auth tokens).
- New tool = `src/tools/<name>.ts` + thin CLI entry in `src/cli/` + `package.json` bin.
- Node **>= 16** required (`package.json` engines).
- **Every `.ts` file you create or materially edit** must follow [Code Comments](#code-comments) (English JSDoc + `@file` header). Touching a file only for typos/formatting does not require a full doc pass.

## Project Summary

`@hanqunfeng/claude-trace` records coding-agent API traffic and renders self-contained HTML reports. Fork of mariozechner/claude-trace with **Claude Code V2+ native binary support**, **OpenCode** via `opencode-trace`, **Codex CLI** via `codex-trace`, and standalone forward-proxy logging via `vibe-coding-proxy`.

## Multi-Tool Architecture

All CLIs share the same core pipeline via **Tool Profiles**:

```
cli/cli.ts | opencode-cli.ts | codex-cli.ts  →  cli/trace-runner.ts  →  intercept/reverse-proxy.ts | intercept/interceptor.ts
                                                    ↑
                                tools/claude.ts | tools/opencode.ts | tools/codex.ts

vibe-coding-proxy-cli.ts → intercept/forward-proxy.ts → intercept/proxy-log-writer.ts → report/html-generator.ts
```

| Tool | CLI command | Log directory | Config injection |
|------|-------------|---------------|------------------|
| Claude Code | `claude-trace` | `.claude-trace/` | `ANTHROPIC_BASE_URL` → proxy; optional persistent `CLAUDE_CONFIG_DIR` overlay when `settings.json` also sets `ANTHROPIC_BASE_URL` |
| OpenCode | `opencode-trace` | `.opencode-trace/` | `OPENCODE_CONFIG_CONTENT` runtime override (original config never modified) |
| Codex CLI | `codex-trace` | `.codex-trace/` | `CODEX_HOME` overlay with rewritten `config.toml` |
| Standalone proxy | `vibe-coding-proxy` | `.vibe-coding-proxy/` | `HTTP_PROXY` / `HTTPS_PROXY`; allowlist-scoped MITM via local CA |

**Data flow:** proxy/interceptor → JSONL in log dir → `report/shared-conversation-processor.ts` → HTML via `report/html-generator.ts` + `frontend/dist/index.global.js`.

## vibe-coding-proxy

`vibe-coding-proxy` is intentionally decoupled from Tool Profiles: it starts only an HTTP/HTTPS forward proxy and prints the proxy URL for callers to export as `HTTP_PROXY`, `HTTPS_PROXY`, or `ALL_PROXY`. It does not spawn Claude Code or rewrite client config.

HTTPS body logging requires MITM. The proxy must only decrypt targets explicitly configured with `--target-url` or `--mitm-host`; all other CONNECT traffic should pass through as a raw tunnel. The local CA lives under `~/.claude-trace/vibe-coding-proxy-ca/` by default and must never be installed into system trust stores automatically.

## Claude Code V2+ (Critical)

Claude Code V2+ is a **native binary**, not Node.js. Do NOT launch it with `node --require interceptor claude` — that causes `SyntaxError: Invalid or unexpected token`.

**Auto-detection in `src/tools/claude.ts` + `src/cli/trace-runner.ts`:**

1. `getBinaryPath()` — resolve real binary (handles bash wrappers, Homebrew Cask, Windows `.cmd`)
2. `isNativeBinary()` — check ELF / Mach-O / PE magic bytes
3. **Native binary** → reverse proxy via `src/intercept/reverse-proxy.ts`
4. **Node.js script** → `intercept/interceptor-loader.js` + `spawn("node", ["--require", loader, jsPath, ...])`

Proxy mode sets `ANTHROPIC_BASE_URL` to the local proxy. If `~/.claude/settings.json` defines its own `ANTHROPIC_BASE_URL` (CC-Switch, LiteLLM, corporate gateways, etc.), `src/config/claude-config-overlay.ts` builds a **persistent** overlay at `~/.claude-trace/claude-config-overlay/` (symlinks/junctions + rewritten `settings.json`; original settings never modified; reused across runs).

## OpenCode

OpenCode always uses **reverse proxy mode** (no V1 fetch hook). Config lookup: `OPENCODE_CONFIG`, `OPENCODE_CONFIG_DIR`, `~/.config/opencode/opencode.json`, `.opencode/opencode.json`. Runtime `OPENCODE_CONFIG_CONTENT` overrides all provider `baseURL` values. Model-based routing supports Anthropic (`@ai-sdk/anthropic`) and OpenAI (`@ai-sdk/openai-compatible`, `@ai-sdk/openai`) via `src/adapt/openai-adapter.ts` and `src/routing/proxy-routing.ts`.

Proxy runtime errors append to `.opencode-trace/proxy-errors.log`. Verbose stderr routing logs: `OPENCODE_TRACE_DEBUG=1` (also used by shared `traceDebug()` for Claude overlay messages).

## Codex CLI

Codex always uses **reverse proxy mode**. Config from `$CODEX_HOME/config.toml` (default `~/.codex/`). `src/config/codex-config-overlay.ts` builds a persistent overlay at `~/.claude-trace/codex-config-overlay/` rewriting `openai_base_url`, `chatgpt_base_url`, and `model_providers.*.base_url`. Path-based routing in `src/routing/codex-routing.ts`: OpenAI API Key (`/v1/responses`) vs ChatGPT OAuth (`/backend-api/codex/responses`). Parsing via `src/adapt/openai-adapter.ts` (`openai-responses` format). WebSocket Responses disabled in overlay for MVP logging.

## Directory Layout

```
src/
  index.ts                                  # programmatic API (HTMLGenerator, interceptor exports)
  types.ts
  cli/
    cli.ts / opencode-cli.ts / codex-cli.ts # thin CLI wrappers
    vibe-coding-proxy-cli.ts                # standalone forward proxy wrapper
    cli-common.ts                           # shared arg parsing, HTML/index helpers
    trace-runner.ts                         # launch + proxy/interceptor dispatch
  intercept/
    reverse-proxy.ts                        # native binary reverse proxy
    forward-proxy.ts                        # standalone HTTP/HTTPS forward proxy
    proxy-log-writer.ts / proxy-targets.ts / mitm-cert.ts
    interceptor.ts                          # V1 fetch() hook (Claude only)
    interceptor-loader.js / token-extractor.js  # copied to dist/intercept/ at build
  config/
    claude-config-overlay.ts                # Claude settings.json overlay
    codex-config-overlay.ts                 # Codex config.toml overlay
  routing/
    proxy-routing.ts / codex-routing.ts
  adapt/
    openai-adapter.ts / api-format.ts
  report/
    html-generator.ts / index-generator.ts
    shared-conversation-processor.ts        # shared parsing (frontend + backend)
  tools/
    types.ts / binary-utils.ts
    claude.ts / opencode.ts / codex.ts
frontend/
  src/                                      # Lit + Tailwind viewer
  dist/                                     # built CSS + IIFE bundle (required for HTML gen)
test/
  *.test.ts                                 # unit tests (routing, adapter, overlay, proxy)
  test-traffic.jsonl                        # sample data for dev preview
```

## Build, Dev & Verification

```bash
npm run setup        # root + frontend dependencies (first time)
npm run build        # tsc + copy .js loaders + frontend build
npm run dev          # watch: tsc + loader copy + frontend
npm run typecheck    # tsc --noEmit
npm run test:unit    # npx tsx --test test/*.test.ts
npm run test:generate  # HTML preview from test-traffic.jsonl
node dist/cli/cli.js | node dist/cli/opencode-cli.js | node dist/cli/codex-cli.js | node dist/cli/vibe-coding-proxy-cli.js
```

**Important:** `tsc` only compiles `.ts`. `interceptor-loader.js` and `token-extractor.js` must be copied to `dist/intercept/` (handled by `build` and `predev`).

| Area changed | Verify with |
|--------------|---------------|
| Proxy / routing / adapter | `npm run test:unit` (`reverse-proxy-path`, `forward-proxy`, `codex-routing`, `opencode-routing`, `openai-adapter`) |
| Config overlay | `claude-config-overlay.test.ts`, `codex-routing.test.ts` |
| HTML / frontend UI | `npm run build` + `npm run test:generate`; edit `frontend/src/` then rebuild frontend |
| Any interception change | typecheck + test:unit + build; smoke `--help` on affected CLI |

## Code Comments

All comments are **English**. Apply whenever you **create** a `.ts` file or **change behavior** in an existing one (`src/`, `frontend/src/`, `test/`, `frontend/tsup.config.ts`).

### Required for every TypeScript file

1. **`@file` header** (first statement) — module purpose, role in the trace pipeline, and non-obvious constraints (e.g. “Claude V2+ only”, “never modify user config on disk”).
2. **Exported symbols** — JSDoc on every exported `function`, `class`, `interface`, `type`, and `const` that acts as API.
3. **Non-exported helpers** — JSDoc when the name alone is not enough (routing, overlay sync, SSE parsing, spawn/env wiring).
4. **Inline comments** — only for non-obvious logic: magic bytes, workaround reasons, security redaction, idempotent shutdown, path normalization. Do **not** restate what the code already says.

### JSDoc fields (use when applicable)

| Field | When |
|-------|------|
| `@param name` | Every parameter whose meaning or valid values are not obvious |
| `@returns` | Non-void functions |
| `@throws` | Documented failure modes that callers should handle |
| `@see` | Related module (e.g. test file → source under test) |

### Scope by area

| Area | Extra expectations |
|------|-------------------|
| `src/tools/*.ts` | Document `ToolProfile` methods, binary resolution, config overlay / env injection |
| `src/intercept/reverse-proxy.ts`, `src/intercept/interceptor.ts` | Request filtering, routing priority, streaming/SSE handling |
| `frontend/src/**` | Lit components: document `render()`, non-trivial private helpers, XSS/sanitization |
| `test/*.test.ts` | `@file` describing suite scope; brief `describe` / `it` intent; fixture constant purpose |

### Style rules

- Prefer **JSDoc blocks** (`/** … */`) over line comments for public API; use `//` for short inline notes.
- Keep comments **accurate** — update or remove them when behavior changes.
- No changelog-style comments (“added in v3”); explain **why**, not git history.
- Do not add comments that duplicate TypeScript types unless the type is intentionally loose (`any`) and the real contract needs spelling out.

### Minimal example

```typescript
/**
 * @file proxy-routing.ts
 * @description Resolves OpenCode model keys to upstream URLs and normalizes API paths.
 */

/**
 * Pick the upstream route for a request body model field.
 * @param modelRoutes - Map built from opencode.json provider config
 * @param model - Value of `model` in the JSON body (may be `provider/id`)
 */
export function resolveModelRoute(
	modelRoutes: Record<string, ModelRoute>,
	model: string | undefined,
): ModelRoute | undefined {
	// Provider fallback keys use `providerId/*` when opencode.json lists no explicit models.
	…
}
```

## Key Conventions

- **Avoid `any`** — use `src/types.ts` and `@anthropic-ai/sdk/resources/messages` (`import type` only; devDependency)
- **No self-referential npm dependency**
- **Package:** `@hanqunfeng/claude-trace`; bins: `claude-trace`, `opencode-trace`, `codex-trace`
- **Log dirs** in cwd (gitignored): `.claude-trace/`, `.opencode-trace/`, `.codex-trace/`
- **Frontend** is a separate package (`frontend/package.json`); run `npm run setup` once

## CLI Flags

Shared across all three CLIs unless noted:

- `--run-with ARGS...` — everything after this is forwarded to the underlying tool (e.g. `opencode-trace --run-with run "prompt"`)
- `--include-all-requests`, `--include-sensitive-headers`, `--log NAME`, `--no-open`
- `--generate-html FILE [OUT]` — offline HTML from JSONL
- `--index` — conversation summaries + searchable index

Tool-specific: `--claude-path`, `--extract-token` (Claude V1 only); `--opencode-path`; `--codex-path`.

Full descriptions: see `README.md`.

## When Modifying Interception

| Change affects | Files to touch |
|----------------|----------------|
| V2+ proxy logging | `src/intercept/reverse-proxy.ts`, possibly `src/types.ts` |
| V1 fetch hook | `src/intercept/interceptor.ts`, `src/intercept/interceptor-loader.js` |
| Binary detection / spawn | `src/cli/trace-runner.ts`, `src/tools/*.ts` |
| New coding tool | `src/tools/<tool>.ts`, new CLI entry in `src/cli/`, `package.json` bin |
| HTML report rendering | `src/report/html-generator.ts`, `frontend/src/` |
| Conversation parsing | `src/report/shared-conversation-processor.ts` |

## Common Pitfalls

1. **Forgetting to build** before `node dist/cli/cli.js` — `dist/intercept/interceptor-loader.js` won't exist
2. **Frontend not built** — HTML generator needs `frontend/dist/index.global.js`
3. **Assuming Claude is Node.js** — V2+ Homebrew/Cask installs are native binaries
4. **Editing only `dist/`** — always change `src/` and rebuild
5. **OpenCode multi-provider** — built-in `models.dev` providers not in `opencode.json` are not intercepted; configured OpenAI/Anthropic providers are supported
6. **Codex is Rust native** — always proxy mode; use `CODEX_HOME` overlay, not Node interceptor
