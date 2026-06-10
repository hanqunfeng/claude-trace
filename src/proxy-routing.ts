import type { ApiFormat, ModelRoute } from "./tools/types";

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

		if (modelRoutes[`${providerId}/*`]) {
			return { ...modelRoutes[`${providerId}/*`], modelId };
		}

		if (modelRoutes[modelId]) {
			return modelRoutes[modelId];
		}
	}

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

export function normalizeUpstreamPath(
	urlPath: string,
	modelRoute?: ModelRoute,
	pathPrefix: string = "",
): string {
	if (modelRoute?.apiFormat === "anthropic" && (urlPath === "/messages" || urlPath.startsWith("/messages?"))) {
		return urlPath.replace(/^\/messages/, "/v1/messages");
	}

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
