/**
 * Canonicalisation + slug-derivation utilities for user-supplied MCP
 * URLs. Single source of truth for both halves of the requested-vs-
 * approved comparison: the same rule runs at IDB-write time (when
 * `/mcp add` records the URL) and at match time (when `/mcp` lists
 * Connected vs Pending).
 */

/**
 * Normalise a user-typed URL into the canonical form we store and
 * compare. Returns `null` when the input fails to parse so callers
 * surface the failure to the user instead of silently persisting
 * garbage.
 *
 * `URL.toString()` handles:
 *  - lowercasing the host
 *  - dropping default ports (`:443` for https, `:80` for http)
 *  - percent-encoding non-ASCII paths
 *  - preserving query + fragment (some MCP endpoints hang state off
 *    them, so stripping would be lossy)
 */
export function canonicalizeMcpUrl(input: string): string | null {
	const trimmed = input.trim();
	if (!trimmed) return null;
	try {
		return new URL(trimmed).toString();
	} catch {
		return null;
	}
}

const GENERIC_HOST_LABELS = new Set(["mcp", "api", "www"]);
const GENERIC_PATH_SEGMENTS = new Set(["mcp", "sse", "v1", "v2", "api"]);

/**
 * Derive a candidate slug from an MCP URL for best-effort matching
 * against `bodhiClient.mcps.list()` entries (which key by `slug` and
 * `name`).
 *
 * Strategy: the most distinctive label in the host (skipping generic
 * `mcp.` / `api.` prefixes), falling back to the last meaningful path
 * segment when the host is generic. Lowercase output. Returns `''`
 * for malformed URLs — callers treat empty-slug entries as unmatched.
 *
 * The heuristic is deliberately permissive: matching is best-effort
 * and the user-facing display always shows the original URL even
 * when matching fails, so a missed match degrades to "URL appears in
 * Pending" rather than data loss.
 */
export function deriveSlugFromUrl(url: string): string {
	try {
		const u = new URL(url);
		const hostLabels = u.hostname.toLowerCase().split(".");
		// Strip generic leading subdomain labels.
		while (hostLabels.length > 1 && GENERIC_HOST_LABELS.has(hostLabels[0])) {
			hostLabels.shift();
		}
		// Drop the TLD to get to the meaningful identifier label.
		const hostSlug = hostLabels.length >= 2 ? hostLabels[0] : (hostLabels[0] ?? "");
		if (hostSlug && hostSlug !== "localhost") return hostSlug;
		// Host is too generic — fall back to the path.
		const segments = u.pathname
			.split("/")
			.map((s) => s.toLowerCase())
			.filter((s) => s.length > 0 && !GENERIC_PATH_SEGMENTS.has(s));
		return segments[segments.length - 1] ?? "";
	} catch {
		return "";
	}
}
