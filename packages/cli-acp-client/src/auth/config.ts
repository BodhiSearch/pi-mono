/**
 * Hardcoded OAuth client + Bodhi auth-server defaults for the CLI.
 *
 * The CLI is a public, distributable client; secrets cannot live here. The
 * client_id is the public identifier of the OAuth registration done at
 * https://developer.getbodhi.app — the corresponding client is registered as
 * `public` (PKCE only, no secret).
 *
 * `authServerUrl` defaults to the dev IdP (matches `BodhiProvider`'s
 * documented dev default at `https://main-id.getbodhi.app/realms/bodhi`).
 * Settings can override per-cwd via `authServerUrl` if the user is
 * targeting prod (`https://id.getbodhi.app/realms/bodhi`).
 */

export const APP_CLIENT_ID = 'bodhi-app-f181a4d1-d7af-43f4-965a-0a8efd453d86';

export const DEFAULT_AUTH_SERVER_URL = 'https://main-id.getbodhi.app/realms/bodhi';

/**
 * Default port the local OAuth callback HTTP server binds to.
 *
 * We intentionally use the same port that `packages/web-acp/`'s Vite
 * dev server runs on (`5173`). The Keycloak public client `cli-acp-
 * client` is registered with `http://localhost:5173/callback` in its
 * allowed `redirect_uri` list — using a random ephemeral port would
 * trip Keycloak's redirect validation and the OAuth round-trip would
 * fail with `invalid_redirect_uri`.
 *
 * Note this implies the CLI cannot run while web-acp's Vite dev server
 * is bound to 5173. Stop one before starting the other.
 */
export const DEFAULT_CALLBACK_PORT = 5173;

/**
 * Static OAuth scopes the CLI always requests. Mirrors the bodhi-js SDK's
 * `DirectWebClient.login → performOAuthPkce(\`openid profile email roles
 * <access_request_scope>\`)`. The dynamic `access_request:<id>` scope is
 * appended via {@link buildScopeString} once Bodhi has approved the
 * consent.
 */
export const DEFAULT_SCOPES = ['openid', 'email', 'profile', 'roles'] as const;

/**
 * Build the full OAuth `scope` string for an access-request login attempt.
 * `accessRequestScope` is the verbatim value Bodhi returns in
 * `access_request_scope` (typically `access_request:<id>`); we fall back to
 * constructing it from the request id if the server didn't include it.
 */
export function buildScopeString(accessRequestId: string, accessRequestScope?: string): string {
  const scope = accessRequestScope ?? `access_request:${accessRequestId}`;
  return [...DEFAULT_SCOPES, scope].join(' ');
}
