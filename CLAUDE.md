# claude-trace — AI Assistant Guide

Always read `README.md` at the beginning of a session.

## Project Summary

`@hanqunfeng/claude-trace` records coding-agent API traffic and renders self-contained HTML reports. Fork of mariozechner/claude-trace with **Claude Code V2+ native binary support** and **OpenCode support** via a separate `opencode-trace` CLI.

## Multi-Tool Architecture

Both CLIs share the same core pipeline via **Tool Profiles**:

```
cli.ts / opencode-cli.ts  →  trace-runner.ts  →  reverse-proxy.ts / interceptor.ts
                                    ↑
                          tools/claude.ts | tools/opencode.ts
```

| Tool | CLI command | Log directory | Config injection |
|------|-------------|---------------|------------------|
| Claude Code | `claude-trace` | `.claude-trace/` | `ANTHROPIC_BASE_URL` + temp `CLAUDE_CONFIG_DIR` |
| OpenCode | `opencode-trace` | `.opencode-trace/` | temp `OPENCODE_CONFIG` with `provider.anthropic.options.baseURL` |

## Claude Code V2+ (Critical)

Claude Code V2+ is a **native binary**, not Node.js. Do NOT launch it with `node --require interceptor claude` — that causes `SyntaxError: Invalid or unexpected token`.

**Auto-detection in `src/tools/claude.ts` + `src/trace-runner.ts`:**

1. `getBinaryPath()` — resolve real binary (handles bash wrappers, Homebrew Cask, Windows `.cmd`)
2. `isNativeBinary()` — check ELF / Mach-O / PE magic bytes
3. **Native binary** → reverse proxy via `src/reverse-proxy.ts`
4. **Node.js script** → original `interceptor-loader.js` + `spawn("node", ["--require", loader, jsPath, ...])`

Proxy mode sets `ANTHROPIC_BASE_URL` to local proxy. If `~/.claude/settings.json` has its own `ANTHROPIC_BASE_URL`, `src/claude-config-overlay.ts` builds a persistent overlay at `~/.claude-trace/claude-config-overlay/` (symlinks/junctions + rewritten `settings.json`; original settings never modified).

## OpenCode

OpenCode always uses **reverse proxy mode** (no V1 fetch hook). Config is read from `OPENCODE_CONFIG`, `OPENCODE_CONFIG_DIR`, `~/.config/opencode/opencode.json`, or `.opencode/opencode.json`. Runtime `OPENCODE_CONFIG_CONTENT` overrides all provider `baseURL` values. Model-based routing supports Anthropic (`@ai-sdk/anthropic`) and OpenAI (`@ai-sdk/openai-compatible`, `@ai-sdk/openai`) API formats via `src/openai-adapter.ts` and `src/proxy-routing.ts`.

## Directory Layout

```
src/
  cli.ts                        # claude-trace entry (thin wrapper)
  opencode-cli.ts               # opencode-trace entry (thin wrapper)
  cli-common.ts                 # Shared arg parsing, HTML/index helpers
  trace-runner.ts               # Generic launch + proxy/interceptor dispatch
  tools/
    types.ts                    # ToolProfile interface
    binary-utils.ts             # isNativeBinary, resolveToJsFile
    claude.ts                   # Claude Code profile + token extraction
    opencode.ts                 # OpenCode profile
  reverse-proxy.ts              # Native binary reverse proxy server
  interceptor.ts                # V1 fetch() hook (Claude only)
  interceptor-loader.js         # V1 --require hook (copied to dist/)
  token-extractor.js            # OAuth token extraction (copied to dist/)
  html-generator.ts             # Self-contained HTML reports
  index-generator.ts            # Conversation index (accepts traceDir)
  shared-conversation-processor.ts  # Shared parsing (frontend + backend)
  openai-adapter.ts             # OpenAI ↔ Anthropic format adapter
  api-format.ts                 # API format detection helpers
  proxy-routing.ts              # Model route resolution + path normalization
  types.ts                      # RawPair, ClaudeData interfaces
frontend/
  src/                          # Lit + Tailwind viewer
  dist/                         # Built CSS + IIFE bundle (required for HTML gen)
test/
  test-traffic.jsonl            # Sample data for dev preview
```

## Build & Dev Commands

```bash
npm run setup        # installs root + frontend dependencies (first time)
npm run build        # tsc + copy .js loaders + frontend build
npm run dev          # predev compiles once, then watch mode
npm run typecheck    # tsc --noEmit
node dist/cli.js     # run claude-trace from source build
node dist/opencode-cli.js  # run opencode-trace from source build
```

**Important:** `tsc` only compiles `.ts` files. `interceptor-loader.js` and `token-extractor.js` must be copied to `dist/` (handled by `build` and `predev` scripts).

## Key Conventions

- **Avoid `any`** — use types from `src/types.ts` and `@anthropic-ai/sdk/resources/messages` (devDependency; `import type` only, not shipped to runtime)
- **No self-referential npm dependency** — package does not depend on itself
- **Package name:** `@hanqunfeng/claude-trace`, bin commands: `claude-trace`, `opencode-trace`
- **Log directories:** `.claude-trace/` and `.opencode-trace/` in cwd (gitignored)
- **Frontend is a separate package** — has its own `package.json`; run `npm run setup` to install both

## CLI Flags

**claude-trace:** `--include-all-requests`, `--include-sensitive-headers`, `--claude-path`, `--log`, `--no-open`, `--extract-token`, `--generate-html`, `--index`

**opencode-trace:** `--include-all-requests`, `--include-sensitive-headers`, `--opencode-path`, `--log`, `--no-open`, `--generate-html`, `--index`

## When Modifying Interception

| Change affects | Files to touch |
|----------------|----------------|
| V2+ proxy logging | `src/reverse-proxy.ts`, possibly `src/types.ts` |
| V1 fetch hook | `src/interceptor.ts`, `src/interceptor-loader.js` |
| Binary detection / spawn | `src/trace-runner.ts`, `src/tools/*.ts` |
| New coding tool | Add `src/tools/<tool>.ts`, new CLI entry, `package.json` bin |
| HTML report rendering | `src/html-generator.ts`, `frontend/src/` |
| Conversation parsing | `src/shared-conversation-processor.ts` |

After changes: `npm run typecheck && npm run build`, then test with `node dist/cli.js` and `node dist/opencode-cli.js`.

## Common Pitfalls

1. **Forgetting to build** before `node dist/cli.js` — `dist/interceptor-loader.js` won't exist
2. **Frontend not built** — HTML generator needs `frontend/dist/index.global.js`
3. **Assuming Claude is Node.js** — V2+ Homebrew/Cask installs are native binaries
4. **Editing only `dist/`** — always change `src/` and rebuild; `fix/` is reference only
5. **OpenCode multi-provider** — Built-in `models.dev` providers not listed in `opencode.json` are not intercepted; configured OpenAI/Anthropic providers are supported
