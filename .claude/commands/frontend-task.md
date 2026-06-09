# Frontend Development Workflow

## Development Environment Setup

The project has a live development environment with immediate feedback loop:

1. **Run development server**: `npm run dev`

   - Continuously rebuilds both backend (`src/`) and frontend (`frontend/src/`) on file changes
   - Serves project at `http://localhost:8080`
   - Auto-generates `test/index.html` from `test/test-traffic.jsonl` via HTML generation

2. **Live preview**: Browser-sync serves `test/index.html` to Chrome

   - Automatic browser refresh on frontend changes
   - Immediate visual feedback when editing frontend code

3. **Screenshot feedback**: Use snap-happy tools for visual verification

   ```bash
   # List windows to get Chrome window ID
   mcp__snap-happy__ListWindows

   # Take screenshot of specific window (Chrome)
   mcp__snap-happy__TakeScreenshot windowId: <chrome_id>
   ```

IMPORTANT: the window id can change! Always list windows before taking a screenshot for a specific app.

## Frontend Styling Guidelines

### Terminal Aesthetics

- **Font size**: Always 12px across ALL elements (no typography variations)
- **Hierarchy**: Use color variations from VS Code theme, not font sizes
- **Background colors**: Used sparingly for sections/highlighting only

### Spacing Rules

- **Vertical spacing**: Always em-based multiples (1em, 2em, etc.)
- **Horizontal spacing**: Always character-based multiples (monospace)
- **Use Tailwind classes**: Never inline styles (`style="..."`)
- **Examples**:

   ```html
   <!-- Good: Terminal spacing with Tailwind -->
   <div class="mb-8 p-4">
   	<span class="mr-12 ml-8">
   		<!-- Bad: Arbitrary px values or inline styles -->
   		<div style="margin-bottom: 32px; padding: 16px">
   			<span style="margin-right: 3em;"></span></div
   	></span>
   </div>
   ```

### Color Usage (VS Code Theme)

- `text-vs-function`: Headers, tool names
- `text-vs-assistant`: Assistant messages
- `text-vs-user`: User messages
- `text-vs-muted`: Secondary info, timestamps
- `text-vs-accent`: Links, hover states
- `bg-vs-bg-secondary`: Content backgrounds
- `border-vs-highlight`: Conversation borders

## HTML Safety

- All text content automatically escaped via `markdownToHtml()` function
- System-reminder tags have special collapsible handling
- No raw HTML injection concerns

## Development Flow

1. Edit frontend files in `frontend/src/`
2. Changes trigger automatic rebuild
3. `test/index.html` updates automatically
4. Browser refreshes to show changes
5. Take screenshot to verify improvements
6. Iterate quickly with immediate visual feedback

This setup enables rapid frontend development with terminal-style consistency and immediate visual verification.
