/**
 * @file Model-based upstream routing and path normalization for OpenCode proxy mode.
 *
 * OpenCode sends requests to a single local proxy URL but may use models from
 * multiple providers (Anthropic, OpenAI-compatible, etc.). This module maps model
 * names to upstream routes, normalizes API paths for provider conventions, and
 * infers API format from URL paths for response parsing.
 */

import type { ApiFormat, ModelRoute } from "../tools/types";

/**
 * Resolves the upstream route for a given model identifier.
 *
 * Lookup order:
 * 1. Exact model name (e.g. `anthropic/claude-sonnet-4-20250514`)
 * 2. `providerId/modelId` when model contains `/`
 * 3. `providerId/*` wildcard with extracted model id
 * 4. Bare `modelId` after stripping provider prefix
 * 5. Single provider fallback when exactly one `isProviderFallback` route exists
 *
 * @param model - Model string from the request JSON body.
 * @param modelRoutes - Model/route table built from OpenCode config.
 * @returns Matching route metadata, or `null` when unresolvable.
 */
export function resolveModelRoute(model: string, modelRoutes: Record<string, ModelRoute>): ModelRoute | null {
	if (modelRoutes[model]) {
		return modelRoutes[model];
	}

	const slashIndex = model.indexOf("/");
	if (slashIndex > 0) {
		const providerId = model.slice(0, slashIndex);
		const modelId = model.slice(slashIndex + 1);

		if (modelRoutes[`${providerId}/${modelId}`]) {
			return modelRoutes[`${providerId}/${modelId}`];
		}

		// Wildcard route: providerId/* matches any model under that provider.
		if (modelRoutes[`${providerId}/*`]) {
			return { ...modelRoutes[`${providerId}/*`], modelId };
		}

		if (modelRoutes[modelId]) {
			return modelRoutes[modelId];
		}
	}

	// When exactly one provider is marked as fallback, use its wildcard route.
	const fallbackProviders = new Set(
		Object.values(modelRoutes)
			.filter((route) => route.isProviderFallback)
			.map((route) => route.providerId),
	);

	if (fallbackProviders.size === 1) {
		const providerId = [...fallbackProviders][0];
		const fallback = modelRoutes[`${providerId}/*`];
		if (fallback) {
			return { ...fallback, modelId: slashIndex > 0 ? model.slice(slashIndex + 1) : model };
		}
	}

	return null;
}

/**
 * Normalizes the request path for the target provider's API conventions.
 *
 * Adjustments:
 * - Anthropic: `/messages` → `/v1/messages` (OpenCode may omit the `/v1` prefix)
 * - OpenAI with base URL ending in `/v1`: strip duplicate `/v1` from chat/responses paths
 *
 * @param urlPath - Request path (without query string).
 * @param modelRoute - Resolved route metadata including `apiFormat`.
 * @param pathPrefix - Path prefix from the upstream base URL.
 * @returns Normalized path to append to the upstream host.
 */
export function normalizeUpstreamPath(
	urlPath: string,
	modelRoute?: ModelRoute,
	pathPrefix: string = "",
): string {
	if (modelRoute?.apiFormat === "anthropic" && (urlPath === "/messages" || urlPath.startsWith("/messages?"))) {
		return urlPath.replace(/^\/messages/, "/v1/messages");
	}

	// Some OpenAI-compatible bases already include `/v1` in pathPrefix; avoid `/v1/v1/...`.
	if (
		modelRoute &&
		(modelRoute.apiFormat === "openai" || modelRoute.apiFormat === "openai-responses") &&
		pathPrefix.endsWith("/v1")
	) {
		if (urlPath === "/v1/chat/completions" || urlPath.startsWith("/v1/chat/completions?")) {
			return urlPath.replace(/^\/v1/, "");
		}
		if (urlPath === "/v1/responses" || urlPath.startsWith("/v1/responses?")) {
			return urlPath.replace(/^\/v1/, "");
		}
	}

	return urlPath;
}

/**
 * Infers the API response format from a request URL path segment.
 *
 * Used by the reverse proxy to choose the correct response parser when no
 * explicit model route provides `apiFormat`.
 *
 * @param urlPath - Request URL path (may include query string).
 * @returns Detected format or `"unknown"`.
 */
export function inferApiFormatFromPath(urlPath: string | undefined): ApiFormat {
	if (!urlPath) {
		return "unknown";
	}
	if (urlPath.includes("/chat/completions")) {
		return "openai";
	}
	if (urlPath.includes("/responses")) {
		return "openai-responses";
	}
	if (urlPath.includes("/messages")) {
		return "anthropic";
	}
	return "unknown";
}
