/**
 * Re-export from `@bodhiapp/web-acp-agent` so the host has one
 * canonical source for MCP URL canonicalisation + slug-derivation.
 * The same rule runs on both halves of the requested-vs-approved
 * comparison (host-side IDB writes and agent-side matching).
 */
export { canonicalizeMcpUrl, deriveSlugFromUrl } from '@bodhiapp/web-acp-agent';
