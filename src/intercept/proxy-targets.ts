/**
 * @file proxy-targets.ts
 * @description Target allowlist matching for vibe-coding-proxy forward interception.
 *
 * Forward proxy CONNECT requests reveal only host and port before TLS is
 * established. This module separates coarse host-level MITM decisions from
 * full URL/path logging decisions after TLS has been decrypted.
 */

/** Normalized URL prefix used to decide whether a request body should be logged. */
export interface ProxyTargetUrl {
	/** Original user-provided URL for help output and diagnostics. */
	raw: string;
	/** Lowercase protocol without the trailing colon (`http` or `https`). */
	protocol: string;
	/** Lowercase hostname used for CONNECT and request matching. */
	hostname: string;
	/** Explicit port, or the default port for the protocol. */
	port: number;
	/** Normalized path prefix; `/` matches every path on the host. */
	pathPrefix: string;
}

/** Configuration for {@link ProxyTargetMatcher}. */
export interface ProxyTargetMatcherConfig {
	/** URL prefixes eligible for full request/response body logging. */
	targetUrls?: string[];
	/** Hostnames eligible for TLS MITM even when no URL prefix is supplied. */
	mitmHosts?: string[];
}

/**
 * Normalizes target URL and host allowlists for forward proxy routing.
 *
 * A target URL implies both host-level MITM permission and full logging for
 * matching URL prefixes. A host-only allowlist permits MITM for that host and
 * logs all decrypted requests for the host.
 */
export class ProxyTargetMatcher {
	private readonly targetUrls: ProxyTargetUrl[];
	private readonly mitmHosts: Set<string>;

	/**
	 * Build a matcher from CLI-provided URL and host allowlists.
	 * @param config - Raw target URLs and hostnames from CLI flags.
	 */
	constructor(config: ProxyTargetMatcherConfig = {}) {
		this.targetUrls = (config.targetUrls || []).map(parseTargetUrl);
		this.mitmHosts = new Set((config.mitmHosts || []).map(normalizeHost));

		for (const target of this.targetUrls) {
			this.mitmHosts.add(target.hostname);
		}
	}

	/** @returns true when no URL or host targets were configured. */
	isEmpty(): boolean {
		return this.targetUrls.length === 0 && this.mitmHosts.size === 0;
	}

	/**
	 * Decide whether a CONNECT host is eligible for TLS interception.
	 * @param hostHeader - CONNECT authority such as `api.deepseek.com:443`.
	 */
	shouldMitmHost(hostHeader: string): boolean {
		const { hostname } = splitHostPort(hostHeader);
		return this.mitmHosts.has(normalizeHost(hostname));
	}

	/**
	 * Decide whether a fully resolved HTTP(S) request URL should be logged.
	 * @param requestUrl - Absolute URL reconstructed by the forward proxy.
	 */
	shouldLogUrl(requestUrl: string): boolean {
		const parsed = new URL(requestUrl);
		const hostname = normalizeHost(parsed.hostname);
		const protocol = parsed.protocol.replace(/:$/, "").toLowerCase();
		const port = parsed.port ? Number(parsed.port) : defaultPort(protocol);
		const path = normalizePathPrefix(parsed.pathname || "/");

		if (this.targetUrls.length === 0) {
			return this.mitmHosts.has(hostname);
		}

		return this.targetUrls.some((target) => {
			if (target.protocol !== protocol || target.hostname !== hostname || target.port !== port) {
				return false;
			}
			if (target.pathPrefix === "/") {
				return true;
			}
			return path === target.pathPrefix || path.startsWith(`${target.pathPrefix}/`);
		});
	}

	/** @returns CLI-friendly target URL display values. */
	listTargetUrls(): string[] {
		return this.targetUrls.map((target) => target.raw);
	}

	/** @returns CLI-friendly MITM host display values. */
	listMitmHosts(): string[] {
		return [...this.mitmHosts].sort();
	}
}

/**
 * Parse a CONNECT authority into host and port components.
 * @param value - Host header or CONNECT authority.
 */
export function splitHostPort(value: string): { hostname: string; port: number } {
	const trimmed = value.trim();
	const ipv6Match = trimmed.match(/^\[([^\]]+)\](?::(\d+))?$/);
	if (ipv6Match) {
		return { hostname: ipv6Match[1], port: ipv6Match[2] ? Number(ipv6Match[2]) : 443 };
	}

	const colonIndex = trimmed.lastIndexOf(":");
	if (colonIndex > -1 && /^\d+$/.test(trimmed.slice(colonIndex + 1))) {
		return {
			hostname: trimmed.slice(0, colonIndex),
			port: Number(trimmed.slice(colonIndex + 1)),
		};
	}
	return { hostname: trimmed, port: 443 };
}

/** Normalize a user-provided hostname for case-insensitive matching. */
function normalizeHost(hostname: string): string {
	return hostname.trim().replace(/^\[|\]$/g, "").toLowerCase();
}

/** Return the default TCP port for a URL protocol. */
function defaultPort(protocol: string): number {
	return protocol === "http" ? 80 : 443;
}

/** Normalize path prefixes so `/foo/` and `/foo` match the same subtree. */
function normalizePathPrefix(pathname: string): string {
	if (!pathname || pathname === "/") {
		return "/";
	}
	return pathname.replace(/\/+$/, "") || "/";
}

/**
 * Parse and validate a target URL prefix.
 * @param raw - User-provided URL from `--target-url`.
 */
function parseTargetUrl(raw: string): ProxyTargetUrl {
	const parsed = new URL(raw);
	const protocol = parsed.protocol.replace(/:$/, "").toLowerCase();
	if (protocol !== "http" && protocol !== "https") {
		throw new Error(`Unsupported target URL protocol: ${raw}`);
	}
	return {
		raw,
		protocol,
		hostname: normalizeHost(parsed.hostname),
		port: parsed.port ? Number(parsed.port) : defaultPort(protocol),
		pathPrefix: normalizePathPrefix(parsed.pathname || "/"),
	};
}
