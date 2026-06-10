export interface ProviderRoute {
	id: string;
	upstreamBaseUrl: string;
	/** Request path prefixes that select this route (Codex multi-upstream). */
	matchPathPrefixes?: string[];
}

export type ApiFormat = "anthropic" | "openai" | "openai-responses" | "unknown";

export interface ModelRoute {
	providerId: string;
	modelId: string;
	upstreamBaseUrl: string;
	npm: string;
	apiFormat: ApiFormat;
	/** True when this route matches any model under providerId (e.g. providerId/*). */
	isProviderFallback?: boolean;
}

export interface ToolProfile {
	name: string;
	displayName: string;
	logDirectory: string;
	findBinary(customPath?: string): string;
	getBinaryPath(customPath?: string): string;
	readUpstreamBaseUrl(): string;
	listProviderRoutes?(): ProviderRoute[];
	listModelRoutes?(): Record<string, ModelRoute>;
	prepareSpawnEnv(proxyUrl: string): { tmpDir: string | null; spawnEnv: NodeJS.ProcessEnv };
	cleanupTempConfig(tmpDir: string | null): void;
	supportsNodeInterceptor(): boolean;
}

export interface TraceOptions {
	includeAllRequests?: boolean;
	openInBrowser?: boolean;
	logBaseName?: string;
	logSensitiveHeaders?: boolean;
	customBinaryPath?: string;
}
