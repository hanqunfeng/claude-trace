# claude-trace — AI Assistant Guide

Always read `README.md` at the beginning of a session.

## Project Summary

`@hanqunfeng/claude-trace` records Claude Code API traffic and renders self-contained HTML reports. Fork of mariozechner/claude-trace with **Claude Code V2+ native binary support**.

## Claude Code V2+ (Critical)

Claude Code V2+ is a **native binary**, not Node.js. Do NOT launch it with `node --require interceptor claude` — that causes `SyntaxError: Invalid or unexpected token`.

**Auto-detection in `src/cli.ts`:**

1. `getClaudeBinaryPath()` — resolve real binary (handles bash wrappers, Homebrew Cask, Windows `.cmd`)
2. `isNativeBinary()` — check ELF / Mach-O / PE magic bytes
3. **Native binary** → `runClaudeNativeWithProxy()` using `src/reverse-proxy.ts`
4. **Node.js script** → original `interceptor-loader.js` + `spawn("node", ["--require", loader, jsPath, ...])`

Proxy mode sets `ANTHROPIC_BASE_URL` to local proxy. If `~/.claude/settings.json` has its own `ANTHROPIC_BASE_URL`, a temp `CLAUDE_CONFIG_DIR` is created (original settings never modified).

## Directory Layout

```
src/
  cli.ts                        # Entry point, binary detection, spawn logic
  reverse-proxy.ts              # V2+ reverse proxy server
  interceptor.ts                # V1 fetch() hook
  interceptor-loader.js         # V1 --require hook (copied to dist/)
  token-extractor.js            # OAuth token extraction (copied to dist/)
  html-generator.ts             # Self-contained HTML reports
  index-generator.ts            # Conversation index
  shared-conversation-processor.ts  # Shared parsing (frontend + backend)
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
node dist/cli.js     # run CLI from source build
```

**Important:** `tsc` only compiles `.ts` files. `interceptor-loader.js` and `token-extractor.js` must be copied to `dist/` (handled by `build` and `predev` scripts).

## Key Conventions

- **Avoid `any`** — use types from `src/types.ts` and `@anthropic-ai/sdk/resources/messages`
- **No self-referential npm dependency** — package does not depend on itself
- **Package name:** `@hanqunfeng/claude-trace`, bin command: `claude-trace`
- **Logs directory:** `.claude-trace/` in cwd (gitignored)
- **Frontend is a separate package** — has its own `package.json`; run `npm run setup` to install both

## CLI Flags (current)

- `--include-all-requests` — log all API traffic (not just `/v1/messages`)
- `--include-sensitive-headers` — skip header redaction (proxy mode)
- `--claude-path` — override Claude binary location
- `--log NAME` — custom log file basename
- `--no-open` — don't open HTML in browser after session

## When Modifying Interception

| Change affects | Files to touch |
|----------------|----------------|
| V2+ proxy logging | `src/reverse-proxy.ts`, possibly `src/types.ts` |
| V1 fetch hook | `src/interceptor.ts`, `src/interceptor-loader.js` |
| Binary detection / spawn | `src/cli.ts` |
| HTML report rendering | `src/html-generator.ts`, `frontend/src/` |
| Conversation parsing | `src/shared-conversation-processor.ts` |

After changes: `npm run typecheck && npm run build`, then test with `node dist/cli.js`.

## Common Pitfalls

1. **Forgetting to build** before `node dist/cli.js` — `dist/interceptor-loader.js` won't exist
2. **Frontend not built** — HTML generator needs `frontend/dist/index.global.js`
3. **Assuming Claude is Node.js** — V2+ Homebrew/Cask installs are native binaries
4. **Editing only `dist/`** — always change `src/` and rebuild; `fix/` is reference only
