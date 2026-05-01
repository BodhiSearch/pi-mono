import { canonicalizeMcpUrl, deriveSlugFromUrl } from "../../../mcp/url-canonical";
import type { BuiltinCommand, BuiltinHandlerCtx, BuiltinMcpInstance, BuiltinResult } from "./types";

/**
 * `/mcp` — manage the persisted requested-MCPs list.
 *
 * Subcommands:
 *  - `/mcp` (no args)        → render Connected (matched approved
 *                              instances) + Pending (requested URLs
 *                              with no matching instance).
 *  - `/mcp add <url>`        → add the URL to the IDB list and
 *                              re-trigger Bodhi login. Idempotent.
 *  - `/mcp remove <url>`     → drop the URL from the IDB list and
 *                              re-trigger Bodhi login. Idempotent.
 *
 * The handler does no IDB I/O — that lives on the main thread (worker
 * has no `idb-keyval` access). Mutations ride on
 * `_meta.bodhi.builtin.action` which the client dispatcher in
 * `useAcp.ts` consumes; the worker only validates input + emits a
 * transcript line that the user sees before the redirect kicks off.
 */
export const mcpCommand: BuiltinCommand = {
	name: "mcp",
	description: "Manage requested MCP servers (list, add, remove).",
	inputHint: "[add <url> | remove <url>]",
	handler: (args, ctx) => {
		const trimmed = args.trim();
		if (!trimmed) return mcpList(ctx);
		const [sub, ...rest] = trimmed.split(/\s+/);
		if (sub === "add") {
			return mcpAdd(rest.join(" ").trim(), ctx);
		}
		if (sub === "remove") {
			return mcpRemove(rest.join(" ").trim(), ctx);
		}
		return {
			replyText: [
				`Unknown subcommand \`${sub}\`. Usage:`,
				"",
				"- `/mcp` — list connected + pending MCP servers",
				"- `/mcp add <url>` — request access to a new MCP server",
				"- `/mcp remove <url>` — revoke a previously-requested MCP server",
			].join("\n"),
		};
	},
};

interface MatchedConnected {
	instance: BuiltinMcpInstance;
	/** The original requested URL when matched, otherwise `null`. */
	requestedUrl: string | null;
}

function mcpList(ctx: BuiltinHandlerCtx): BuiltinResult {
	const { matchedConnected, pending } = matchRequestedAgainstApproved(ctx);
	const lines: string[] = ["**MCP servers**", ""];
	if (matchedConnected.length === 0 && pending.length === 0) {
		lines.push("_No MCP servers requested yet._");
		lines.push("");
		lines.push("Use `/mcp add <url>` to request access to an MCP server.");
		return { replyText: lines.join("\n") };
	}
	if (matchedConnected.length > 0) {
		lines.push(`**Connected (${matchedConnected.length})**`);
		lines.push("");
		for (const entry of matchedConnected) {
			const display = entry.requestedUrl ?? buildBodhiProxyUrl(ctx.serverUrl, entry.instance.path);
			lines.push(`- \`${display}\` — slug \`${entry.instance.slug}\``);
		}
		lines.push("");
	}
	if (pending.length > 0) {
		lines.push(`**Pending or denied (${pending.length})**`);
		lines.push("");
		for (const url of pending) {
			lines.push(`- \`${url}\``);
		}
		lines.push("");
		lines.push("_Pending entries are URLs you requested that Bodhi has not approved._");
	}
	lines.push("");
	lines.push("Use `/mcp add <url>` or `/mcp remove <url>` to mutate the list.");
	return { replyText: lines.join("\n") };
}

function mcpAdd(rawUrl: string, ctx: BuiltinHandlerCtx): BuiltinResult {
	if (!rawUrl) {
		return { replyText: "Usage: `/mcp add <url>`" };
	}
	const canonical = canonicalizeMcpUrl(rawUrl);
	if (!canonical) {
		return { replyText: `\`${rawUrl}\` is not a valid URL.` };
	}
	if (ctx.requestedMcpUrls.includes(canonical)) {
		return {
			replyText: `\`${canonical}\` is already in your requested list — no re-auth needed.`,
		};
	}
	return {
		replyText: [
			`Re-authenticating to add \`${canonical}\`.`,
			"",
			"You'll return here after Bodhi approves the new scope.",
		].join("\n"),
		action: { kind: "mcp-add", params: { url: canonical } },
	};
}

function mcpRemove(rawUrl: string, ctx: BuiltinHandlerCtx): BuiltinResult {
	if (!rawUrl) {
		return { replyText: "Usage: `/mcp remove <url>`" };
	}
	const canonical = canonicalizeMcpUrl(rawUrl);
	if (!canonical) {
		return { replyText: `\`${rawUrl}\` is not a valid URL.` };
	}
	if (!ctx.requestedMcpUrls.includes(canonical)) {
		const lines = [
			`\`${canonical}\` is not in your requested list.`,
			"",
			ctx.requestedMcpUrls.length === 0
				? "_The requested list is empty._"
				: `Currently requested: ${ctx.requestedMcpUrls.map((u) => `\`${u}\``).join(", ")}.`,
		];
		return { replyText: lines.join("\n") };
	}
	return {
		replyText: [
			`Removing \`${canonical}\` and re-authenticating with the reduced list.`,
			"",
			"You'll return here after Bodhi confirms.",
		].join("\n"),
		action: { kind: "mcp-remove", params: { url: canonical } },
	};
}

interface MatchedSets {
	matchedConnected: MatchedConnected[];
	pending: string[];
}

/**
 * Best-effort matching between approved Bodhi instances (slug + name)
 * and requested URLs. We derive a candidate slug from each URL and
 * compare against `instance.slug` (case-insensitive); when slugs
 * differ we also try the instance's display `name`.
 *
 * Result invariants:
 *  - Every Connected entry shows the original URL when matched, or
 *    falls back to the Bodhi proxy URL when no requested URL maps to it.
 *  - Pending = requested URLs that didn't match any Connected entry.
 */
function matchRequestedAgainstApproved(ctx: BuiltinHandlerCtx): MatchedSets {
	const matchedConnected: MatchedConnected[] = [];
	const matchedRequested = new Set<string>();
	for (const instance of ctx.mcpInstances) {
		const requested = findRequestedMatch(instance, ctx.requestedMcpUrls);
		if (requested) matchedRequested.add(requested);
		matchedConnected.push({ instance, requestedUrl: requested });
	}
	const pending = ctx.requestedMcpUrls.filter((url) => !matchedRequested.has(url));
	return { matchedConnected, pending };
}

function findRequestedMatch(instance: BuiltinMcpInstance, requested: string[]): string | null {
	const slug = instance.slug.toLowerCase();
	const name = instance.name.toLowerCase();
	for (const url of requested) {
		const candidate = deriveSlugFromUrl(url);
		if (!candidate) continue;
		if (candidate === slug) return url;
		if (candidate === name) return url;
		// The slug heuristic can sometimes pick the second-most distinctive
		// label — e.g. `mcp.deepwiki.com` → `deepwiki`, but Bodhi might
		// call it `deepwiki-mcp`. Allow a substring match in either
		// direction so close-but-not-exact slugs still pair up.
		if (slug.includes(candidate) || candidate.includes(slug)) return url;
	}
	return null;
}

function buildBodhiProxyUrl(serverUrl: string | null, path: string): string {
	if (!serverUrl) return path;
	const base = serverUrl.replace(/\/+$/, "");
	const suffix = path.startsWith("/") ? path : `/${path}`;
	return `${base}${suffix}`;
}
