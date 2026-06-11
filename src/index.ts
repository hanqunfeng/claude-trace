/**
 * @file index.ts
 * @description Public package entry point for programmatic use of claude-trace.
 *
 * Re-exports the traffic logger (V1 interceptor), HTML generator, and shared
 * types so consumers can embed logging or report generation without invoking
 * the CLI binaries directly.
 */

// Main exports for the package
export { ClaudeTrafficLogger, initializeInterceptor, getLogger, InterceptorConfig } from "./intercept/interceptor";
export { HTMLGenerator } from "./report/html-generator";
export { RawPair, ClaudeData, HTMLGenerationData, TemplateReplacements } from "./types";

// Re-export everything for convenience
export * from "./intercept/interceptor";
export * from "./report/html-generator";
export * from "./types";
