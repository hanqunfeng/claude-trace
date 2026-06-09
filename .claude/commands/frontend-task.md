# Frontend Development Workflow

Invoke this command in Claude Code: `/frontend-task`

Guides frontend work on the HTML log viewer in `frontend/src/`. Does not affect the CLI or reverse proxy in `src/`.

## First-Time Setup

From the repository root:

```bash
npm run setup    # installs root + frontend dependencies
npm run build    # ensures dist/ exists for build:html in dev rebuild
```

## Development Environment

1. **Start dev server** (from repo root):

   ```bash
   npm run dev
   ```

   - `predev` compiles backend and copies `interceptor-loader.js` / `token-extractor.js` to `dist/`
   - Watches `src/` (TypeScript) and `frontend/src/` (Lit + Tailwind)
   - Rebuilds frontend CSS/JS and regenerates `test/index.html` from `test/test-traffic.jsonl`

2. **Live preview**:

   - Open **http://localhost:8080/test** in a browser
   - browser-sync auto-refreshes on HTML/CSS/JS changes
   - Sample data: `test/test-traffic.jsonl` → `test/index.html`

3. **Visual verification**:

   - Rely on browser-sync live reload after edits
   - Manually check conversation, raw, and JSON views in the preview
   - Run `npm run typecheck` in repo root (or `cd frontend && npm run typecheck`) before committing

## Key Frontend Files

| Path | Purpose |
|------|---------|
| `frontend/src/app.ts` | Main app, view switching |
| `frontend/src/components/simple-conversation-view.ts` | Conversation + tool UI |
| `frontend/src/components/raw-pairs-view.ts` | Raw HTTP viewer |
| `frontend/src/components/json-view.ts` | JSON debug viewer |
| `frontend/src/utils/markdown.ts` | `markdownToHtml()` with escaping |
| `frontend/src/styles.css` | Tailwind + VS Code theme |
| `frontend/tailwind.config.js` | `vs-*` color tokens |

Built output (`frontend/dist/`) is embedded into self-contained HTML reports by `src/html-generator.ts`.

## Frontend Styling Guidelines

### Terminal Aesthetics

- **Font size**: 12px globally (`html, body { font-size: 12px }` in `styles.css`)
- **Hierarchy**: Use VS Code theme colors, not larger font sizes
- **Headings in markdown**: `font-size: inherit` — same size as body, bold only
- **Background colors**: Sparingly, for sections/highlighting

### Spacing Rules

- **Vertical spacing**: em-based multiples (`1em`, `2em`, Tailwind `mb-4`, `mt-4`, etc.)
- **Horizontal spacing**: character/monospace multiples where appropriate
- **Use Tailwind classes**: Avoid inline `style="..."`

```html
<!-- Good -->
<div class="mb-4 p-4 bg-vs-bg-secondary text-vs-text">
  <span class="mr-8 text-vs-muted">timestamp</span>
</div>

<!-- Bad -->
<div style="margin-bottom: 32px; padding: 16px">
```

### Color Tokens (Tailwind `vs-*`)

Defined in `frontend/tailwind.config.js`:

- `text-vs-function` — headers, tool names
- `text-vs-assistant` — assistant messages
- `text-vs-user` — user messages
- `text-vs-muted` — secondary info, timestamps
- `text-vs-accent` — links, hover states
- `text-vs-type` — types, tool labels
- `bg-vs-bg-secondary` — content panels
- `border-vs-highlight` — conversation borders

## HTML Safety

- User-facing text goes through `markdownToHtml()` in `frontend/src/utils/markdown.ts`
- HTML entities escaped before markdown rendering
- Do not inject unescaped raw HTML from API data

## Development Flow

1. Run `npm run dev` from repo root
2. Open http://localhost:8080/test
3. Edit files under `frontend/src/`
4. Wait for rebuild; browser refreshes automatically
5. Verify all three views (conversations / raw / json) if the change is broad
6. Run typecheck before finishing

## Constraints

- Avoid `any` — use types from `src/types.ts` and `@anthropic-ai/sdk/resources/messages`
- Frontend uses **Lit** (no React/Vue); components use light DOM (`createRenderRoot() { return this }`) for global Tailwind
- Do not add `postinstall` or assume `snap-happy` — not part of this repository
