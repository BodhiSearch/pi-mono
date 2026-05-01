import { z } from 'zod';

/**
 * Persistent settings stored at `$cwd/.cli-acp-client/settings.json`.
 *
 * - `host`: BodhiApp base URL the user set via `/host`. No default — absence
 *   means "disconnected, run /host to begin".
 * - `authServerUrl`: optional override for the Keycloak realm; falls back to
 *   the hardcoded dev default in `auth/config.ts` when absent.
 * - `tokens`: stored verbatim from the Keycloak token response. Plaintext on
 *   disk for v0; replace with OS keychain in a follow-up.
 * - `lastModelId`: most recently selected model id, surfaced as the default
 *   on next launch so `/model` doesn't have to be re-typed.
 * - `requestedMcps`: MCP server URLs the user has asked Bodhi to approve via
 *   `/mcp add`. Mirrors the browser SDK's IDB-stored list — survives logout
 *   so the next login keeps the resource set stable.
 */

export const TokenBundleSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string().optional(),
  tokenType: z.string().default('Bearer'),
  expiresAt: z.number().int().nonnegative(),
  scope: z.string().optional(),
});

export const SettingsSchema = z.object({
  host: z.string().url().optional(),
  authServerUrl: z.string().url().optional(),
  /**
   * Local port the OAuth callback server binds to. When unset, the CLI
   * uses the hardcoded default (5173 — the port web-acp's Keycloak
   * client is registered against). Override here only if you have a
   * separate IdP registration with a different `redirect_uri`.
   */
  callbackPort: z.number().int().min(1).max(65_535).optional(),
  tokens: TokenBundleSchema.optional(),
  lastModelId: z.string().optional(),
  requestedMcps: z.array(z.string().url()).default([]),
});

export type TokenBundle = z.infer<typeof TokenBundleSchema>;
export type Settings = z.infer<typeof SettingsSchema>;

export const DEFAULT_SETTINGS: Settings = {
  requestedMcps: [],
};
