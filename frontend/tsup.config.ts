/**
 * @file tsup build configuration for the trace viewer IIFE bundle.
 *
 * Produces `dist/index.global.js` (global `ClaudeApp`) with Lit, marked, and
 * highlight.js inlined. CSS is read from `dist/styles.css` at build time and
 * injected via the `__CSS_CONTENT__` compile-time define.
 */

import { defineConfig } from "tsup";
import { readFileSync } from "fs";
import { join } from "path";

/** tsup configuration producing the self-contained IIFE consumed by {@link HTMLGenerator}. */
export default defineConfig({
	entry: ["src/index.ts"],
	format: ["iife"],
	outDir: "dist",
	globalName: "ClaudeApp",
	minify: true,
	sourcemap: "inline",
	clean: false, // Don't clean CSS file — Tailwind build writes styles.css separately
	noExternal: ["lit", "marked", "highlight.js"],
	target: "es2022",
	esbuildOptions: (options) => {
		options.banner = {
			js: "/* Claude Tools Frontend Bundle */",
		};

		// Source maps enabled for debugging

		// Inject CSS content — read dynamically on each build so rebuilds pick up style changes
		options.define = {
			...options.define,
			get __CSS_CONTENT__() {
				try {
					return JSON.stringify(readFileSync(join(process.cwd(), "dist/styles.css"), "utf8"));
				} catch {
					return JSON.stringify("");
				}
			},
		};
	},
});
