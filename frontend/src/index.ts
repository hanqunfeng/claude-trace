/**
 * @file Frontend entry point for the self-contained HTML trace viewer.
 *
 * Injects compiled Tailwind CSS, registers Lit child components, and mounts
 * {@link ClaudeApp} onto the `#app` element embedded by `template.html`.
 */

import { ClaudeApp } from "./app";
import "./components/simple-conversation-view";
import "./components/raw-pairs-view";
import "./components/json-view";

// Injected at build time by tsup via the __CSS_CONTENT__ define
declare const __CSS_CONTENT__: string;
const css = __CSS_CONTENT__;
if (css && css !== "__CSS_CONTENT__") {
	const style = document.createElement("style");
	style.textContent = css;
	document.head.appendChild(style);
}

// Initialize the application when DOM is ready
if (document.readyState === "loading") {
	document.addEventListener("DOMContentLoaded", initApp);
} else {
	initApp();
}

/** Creates and appends the root Lit application element. */
function initApp() {
	const app = new ClaudeApp();
	const appElement = document.getElementById("app");
	if (appElement) {
		appElement.appendChild(app);
	} else {
		console.error("App mount point not found");
	}
}
