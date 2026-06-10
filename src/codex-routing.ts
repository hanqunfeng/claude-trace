import type { ProviderRoute } from "./tools/types";

interface ParsedTarget {
	protocol: string;
	targetHost: string;
	targetPort: number;
	pathPrefix: string;
}

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
