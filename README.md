# claude-trace

Record all your interactions with Claude Code as you develop your projects. See everything Claude hides: system prompts, tool outputs, and raw API data in an intuitive web interface.

**Fork of [mariozechner/claude-trace](https://github.com/mariozechner/claude-trace) with full [Claude Code V2+](https://docs.anthropic.com/en/docs/claude-code) support** (native binary via reverse proxy).

## Claude Code V2+ Support

Claude Code V2 ships as a **native binary** (Mach-O on macOS, ELF on Linux, PE on Windows) instead of a Node.js script. The original interceptor approach (`node --require interceptor claude`) no longer works.

This fork automatically detects the binary type and picks the right interception strategy:

| Claude Code version | Binary type | Interception mode |
|---------------------|-------------|-------------------|
| V1.x | Node.js script | `interceptor-loader.js` injected via `--require` |
| **V2+** | Native binary | Local **reverse proxy**; `ANTHROPIC_BASE_URL` redirected |

When running against a native binary, claude-trace:

1. Starts a local HTTP reverse proxy on `127.0.0.1`
2. Points Claude Code at the proxy via `ANTHROPIC_BASE_URL`
3. Forwards traffic to the real API (reads `~/.claude/settings.json` or `ANTHROPIC_BASE_URL` env)
4. Logs all request/response pairs to `.claude-trace/` in real time

If your `~/.claude/settings.json` already sets `ANTHROPIC_BASE_URL`, a temporary config directory is used so the original settings file is never modified.

## Install

### From npm (when published)

```bash
npm install -g @hanqunfeng/claude-trace
```

### From source

```bash
git clone https://github.com/hanqunfeng/claude-trace.git
cd claude-trace
npm run setup  # installs root + frontend dependencies
npm run build
npm link       # optional: make `claude-trace` available globally
```

## Usage

```bash
# Start Claude Code with logging (auto-detects V1 JS vs V2+ native binary)
claude-trace

# Include all API requests (by default, only /v1/messages are logged in proxy mode)
claude-trace --include-all-requests

# Log auth headers without redaction (use with care)
claude-trace --include-sensitive-headers

# Run Claude with specific arguments
claude-trace --run-with chat --model sonnet-3.5

# Use a custom Claude binary path
claude-trace --claude-path /usr/local/Caskroom/claude-code/2.1.153/claude

# Show help
claude-trace --help

# Extract OAuth token
claude-trace --extract-token

# Generate HTML report from previously logged .jsonl
claude-trace --generate-html logs.jsonl report.html

# Generate HTML including all requests
claude-trace --generate-html logs.jsonl --include-all-requests

# Generate conversation summaries and searchable index
claude-trace --index
```

Logs are saved to `.claude-trace/log-YYYY-MM-DD-HH-MM-SS.{jsonl,json,html}` in your current directory. The HTML file is self-contained and opens in any browser without needing a server.

## CLI Options

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

## Request Filtering

**Proxy mode (Claude Code V2+):**

- **Default**: Logs requests to `/v1/messages`
- **With `--include-all-requests`**: Logs all proxied API traffic

**Interceptor mode (Claude Code V1, Node.js):**

- **Default**: Logs `/v1/messages` requests with more than 2 messages in context
- **With `--include-all-requests`**: Logs all `api.anthropic.com` requests

## Conversation Indexing

Generate AI-powered summaries of your coding sessions:

```bash
claude-trace --index
```

This feature:

- Scans all `.jsonl` log files in `.claude-trace/` directory
- Filters meaningful conversations (more than 2 messages, non-compacted)
- Uses Claude CLI to generate titles and summaries for each conversation
- Creates `summary-YYYY-MM-DD-HH-MM-SS.json` files with conversation metadata
- Generates a master `index.html` with chronological listing of all sessions
- Links directly to individual conversation HTML files

**Note:** Indexing will incur additional API token usage as it calls Claude to summarize conversations.

## What you'll see

- **System prompts** - The hidden instructions Claude receives
- **Tool definitions** - Available tool descriptions and parameters
- **Tool outputs** - Raw data from file reads, searches, API calls
- **Thinking blocks** - Claude's internal reasoning process
- **Token usage** - Detailed breakdown including cache hits
- **Raw JSONL logs** - Complete request/response pairs for analysis
- **Interactive HTML viewer** - Browse conversations with model filtering
- **Debug views** - Raw calls shows all HTTP requests; JSON debug shows processed API data
- **Conversation indexing** - AI-generated summaries and searchable index of all sessions

## Requirements

- Node.js 16+
- Claude Code CLI installed (V1 Node.js or **V2+ native binary**)

## Development

### Running in dev mode

```bash
npm run setup    # first time: installs root + frontend dependencies
npm run dev      # predev compiles + copies JS loaders, then starts watchers
```

Dev mode compiles both the main app (`src/`) and frontend (`frontend/src/`) with file watching. Open `http://localhost:8080/test` to preview the HTML viewer with sample data.

### Testing the CLI

```bash
# Build first
npm run build

# Run compiled CLI
node dist/cli.js

# Type-check without emitting
npm run typecheck
```

### Building

```bash
npm run build
```

**Generated artifacts:**

- `dist/` - Compiled CLI, interceptor, and reverse proxy
- `frontend/dist/` - Bundled web interface (CSS + JS)
- Self-contained HTML reports with embedded CSS/JS

### Architecture

**Two-part system with dual interception:**

1. **Backend** (`src/`)

   - **CLI** (`cli.ts`) - Detects native vs Node.js Claude binary; launches appropriate interception mode
   - **Reverse Proxy** (`reverse-proxy.ts`) - **Claude Code V2+**: local HTTP proxy, logs traffic, generates HTML in real time
   - **Interceptor** (`interceptor.ts`) - **Claude Code V1**: hooks `fetch()` inside Node.js Claude process
   - **Interceptor Loader** (`interceptor-loader.js`) - `--require` hook for V1 Node.js entry
   - **HTML Generator** (`html-generator.ts`) - Embeds frontend into self-contained HTML reports
   - **Index Generator** (`index-generator.ts`) - AI-powered conversation summaries and searchable index
   - **Shared Conversation Processor** (`shared-conversation-processor.ts`) - Core conversation processing shared between frontend and backend
   - **Token Extractor** (`token-extractor.js`) - Extracts Claude Code OAuth tokens (V1 Node.js path)

2. **Frontend** (`frontend/src/`)

   - **`app.ts`** - Main ClaudeApp component, data processing and view switching
   - **`index.ts`** - Application entry point
   - **`components/simple-conversation-view.ts`** - Conversation display with tool visualization
   - **`components/raw-pairs-view.ts`** - Raw HTTP traffic viewer
   - **`components/json-view.ts`** - JSON debug data viewer
   - **`styles.css`** - Tailwind CSS with VS Code theme variables

## License

MIT — originally by [Mario Zechner](https://github.com/mariozechner/claude-trace), maintained as [@hanqunfeng/claude-trace](https://github.com/hanqunfeng/claude-trace).
