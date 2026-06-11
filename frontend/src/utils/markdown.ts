/**
 * @file Safe markdown-to-HTML conversion for the trace viewer.
 *
 * Escapes raw HTML before parsing with `marked` to reduce XSS risk when
 * rendering user and assistant message content in the self-contained report.
 */

import { marked } from "marked";

// Configure marked for safe HTML rendering
marked.setOptions({
	gfm: true, // GitHub Flavored Markdown
	breaks: true, // Convert \n to <br>
});

/**
 * Escape HTML entities to prevent XSS when content is later parsed as markdown.
 */
function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

/**
 * Convert markdown text to an HTML string with entity escaping applied first.
 *
 * @param markdown - Raw markdown from logged messages.
 * @returns HTML string safe for `unsafeHTML` rendering in Lit templates.
 */
export function markdownToHtml(markdown: string): string {
	if (!markdown) return "";

	try {
		// First escape any existing HTML entities to prevent XSS
		const escapedMarkdown = escapeHtml(markdown);
		return marked(escapedMarkdown) as string;
	} catch (error) {
		console.warn("Failed to parse markdown:", error);
		// Fallback to plain text with basic line break handling and HTML escaping
		return escapeHtml(markdown).replace(/\n/g, "<br>");
	}
}
