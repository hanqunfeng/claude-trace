/**
 * @file tools/types.ts
 * @description Core abstractions for multi-tool tracing via Tool Profiles.
 *
 * Each supported CLI (Claude Code, OpenCode, Codex) implements `ToolProfile`
 * so `trace-runner.ts` can launch the tool with either a Node.js fetch hook
 * or a local reverse proxy without tool-specific branching in the runner.
 */

/** Upstream API endpoint configuration for a single provider (Codex multi-upstream). */
export interface ProviderRoute {
	/** Stable route identifier used for path-based dispatch. */
	id: string;
	/** Real upstream base URL before proxy rewrite. */
	upstreamBaseUrl: string;
	/** Request path prefixes that select this route (Codex multi-upstream). */
	matchPathPrefixes?: string[];
	/**
	 * When set, forward to this exact upstream path instead of concatenating
	 * {@link upstreamBaseUrl} path prefix with the request path (Codex Apps MCP remapping).
	 */
	fixedUpstreamPath?: string;
}

/**
 * Wire format of the upstream LLM API.
 * Used for parsing, display labels, and adapter selection in the reverse proxy.
 */
export type ApiFormat = "anthropic" | "openai" | "openai-responses" | "unknown";

/**
 * Model-specific routing entry for OpenCode-style `provider/model` keys.
 * Maps a configured model to its upstream URL and expected API format.
 */
export interface ModelRoute {
	providerId: string;
	modelId: string;
	upstreamBaseUrl: string;
	/** npm package name hint from OpenCode config (e.g. "@ai-sdk/anthropic"). */
	npm: string;
	apiFormat: ApiFormat;
	/** True when this route matches any model under providerId (e.g. providerId/*). */
	isProviderFallback?: boolean;
}

/**
 * Pluggable profile describing how to find, configure, and spawn a coding CLI.
 * Implemented by `claude.ts`, `opencode.ts`, and `codex.ts`.
 */
export interface ToolProfile {
	/** Short machine name: "claude" | "opencode" | "codex". */
	name: string;
	/** Human-readable label for CLI output. */
	displayName: string;
	/** Relative log directory under cwd (e.g. ".claude-trace"). */
	logDirectory: string;
	/** Resolve binary path on PATH or from optional custom override. */
	findBinary(customPath?: string): string;
	/** Resolve wrapper scripts/symlinks to the executable used for spawn. */
	getBinaryPath(customPath?: string): string;
	/** Default upstream base URL when no per-provider routes exist. */
	readUpstreamBaseUrl(): string;
	/** Optional list of provider routes (Codex, multi-provider setups). */
	listProviderRoutes?(): ProviderRoute[];
	/** Optional model-keyed routes for OpenCode proxy routing. */
	listModelRoutes?(): Record<string, ModelRoute>;
	/**
	 * Build process environment for spawning the tool against the local proxy.
	 * @param proxyUrl - Full local proxy URL (e.g. http://127.0.0.1:PORT)
	 * @returns tmpDir - Overlay config directory to clean up, or null if none
	 * @returns spawnEnv - Complete env vars for child process
	 */
	prepareSpawnEnv(proxyUrl: string): { tmpDir: string | null; spawnEnv: NodeJS.ProcessEnv };
	/** Remove temporary overlay directory created by prepareSpawnEnv. */
	cleanupTempConfig(tmpDir: string | null): void;
	/** Whether V1 Node `--require interceptor` mode is supported for this tool. */
	supportsNodeInterceptor(): boolean;
}

/** Runtime options passed from CLI entry points to trace-runner. */
export interface TraceOptions {
	/** Log all proxied/fetched requests, not only primary message endpoints. */
	includeAllRequests?: boolean;
	/** Open the generated HTML report when the session ends. */
	openInBrowser?: boolean;
	/** Custom log file base name (without extension) under logDirectory. */
	logBaseName?: string;
	/** Disable redaction of Authorization, Cookie, and similar headers. */
	logSensitiveHeaders?: boolean;
	/** User-supplied path to the tool binary (--claude-path, etc.). */
	customBinaryPath?: string;
}
