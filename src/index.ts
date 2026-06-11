/**
 * @file index.ts
 * @description Public package entry point for programmatic use of claude-trace.
 *
 * Re-exports the traffic logger (V1 interceptor), HTML generator, and shared
 * types so consumers can embed logging or report generation without invoking
 * the CLI binaries directly.
 */

// Main exports for the package
export { ClaudeTrafficLogger, initializeInterceptor, getLogger, InterceptorConfig } from "./interceptor";
export { HTMLGenerator } from "./html-generator";
export { RawPair, ClaudeData, HTMLGenerationData, TemplateReplacements } from "./types";

// Re-export everything for convenience
export * from "./interceptor";
export * from "./html-generator";
export * from "./types";
