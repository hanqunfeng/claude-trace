/**
 * @file Path-based upstream routing for Codex CLI reverse-proxy mode.
 *
 * Codex uses different upstream endpoints depending on auth mode:
 * - OpenAI API key → `/v1/responses`
 * - ChatGPT OAuth → `/backend-api/codex/responses`
 * - ChatGPT Apps MCP (`codex_apps`) → `/backend-api/wham/apps`
 *
 * The trace proxy matches incoming request paths against configured
 * {@link ProviderRoute.matchPathPrefixes} and forwards to the appropriate upstream base URL.
 */

import type { ProviderRoute } from "../tools/types";

/** Parsed components of an upstream base URL used to build outbound requests. */
interface ParsedTarget {
	/** URL scheme (`https:` or `http:`). */
	protocol: string;
	/** Upstream hostname for TLS SNI and the HTTP `Host` header. */
	targetHost: string;
	/** Upstream TCP port (443/80 when omitted from the URL). */
	targetPort: number;
	/** Path prefix from the base URL, without trailing slash. */
	pathPrefix: string;
}

/**
 * Parses a base URL into host, port, protocol, and path prefix.
 *
 * @param targetBaseUrl - Full upstream base URL from a provider route.
 * @returns Parsed target suitable for constructing upstream requests.
 */
function parseTargetBaseUrl(targetBaseUrl: string): ParsedTarget {
	const parsed = new URL(targetBaseUrl);
	const pathPrefix = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/$/, "");
	return {
		protocol: parsed.protocol,
		targetHost: parsed.hostname,
		targetPort: parsed.port
			? parseInt(parsed.port, 10)
			: parsed.protocol === "https:" ? 443 : 80,
		pathPrefix,
	};
}

/**
 * Finds the first provider route whose path prefix matches the request URL.
 *
 * Prefix matching is exact or prefix-with-slash (e.g. `/v1/responses` matches
 * `/v1/responses` and `/v1/responses/compact`).
 *
 * @param reqUrl - Incoming request URL (may include query string).
 * @param routes - Ordered list of provider routes to try.
 * @returns Matching route or `null` when no prefix matches.
 */
function matchRouteByPath(reqUrl: string | undefined, routes: ProviderRoute[]): ProviderRoute | null {
	if (!reqUrl) {
		return null;
	}

	const [rawPath] = reqUrl.split("?");

	for (const route of routes) {
		const prefixes = route.matchPathPrefixes;
		if (!prefixes?.length) {
			continue;
		}
		if (prefixes.some((prefix) => rawPath === prefix || rawPath.startsWith(`${prefix}/`))) {
			return route;
		}
	}

	return null;
}

/**
 * Resolves the upstream target for a Codex proxied request based on URL path.
 *
 * When no route matches, returns the fallback target with the original path appended.
 * When a route matches, constructs the upstream path relative to the route's base URL,
 * avoiding double-prefixing when the request path already includes the base path prefix.
 *
 * @param reqUrl - Incoming request URL from Codex CLI.
 * @param routes - Path-prefix → upstream route table from the Codex tool profile.
 * @param fallback - Default upstream when no path route matches.
 * @returns Parsed target plus the full upstream display path (for logging and forwarding).
 */
export function resolveCodexRouteTarget(
	reqUrl: string | undefined,
	routes: ProviderRoute[],
	fallback: ParsedTarget,
): ParsedTarget & { upstreamDisplayPath: string } {
	const matched = matchRouteByPath(reqUrl, routes);
	if (!matched) {
		const upstreamDisplayPath = `${fallback.pathPrefix}${reqUrl || "/"}`;
		return { ...fallback, upstreamDisplayPath };
	}

	const target = parseTargetBaseUrl(matched.upstreamBaseUrl);
	const [rawPath, query = ""] = (reqUrl || "/").split("?");

	if (matched.fixedUpstreamPath) {
		const upstreamDisplayPath = `${matched.fixedUpstreamPath}${query ? `?${query}` : ""}`;
		return {
			...target,
			upstreamDisplayPath,
		};
	}

	// If the request path already starts with the target's path prefix, don't prepend again.
	const upstreamPath =
		target.pathPrefix && rawPath.startsWith(target.pathPrefix)
			? rawPath
			: `${target.pathPrefix}${rawPath}`;
	const upstreamDisplayPath = `${upstreamPath}${query ? `?${query}` : ""}`;

	return {
		...target,
		upstreamDisplayPath,
	};
}
