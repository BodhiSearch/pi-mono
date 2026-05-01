/**
 * OAuth 2.1 PKCE token endpoint glue against Keycloak.
 *
 * Two flows:
 *   - `exchangeCodeForTokens` — initial code-for-token exchange after
 *     the callback redirect. Posts `grant_type=authorization_code` with
 *     the PKCE verifier, no client secret (public client).
 *   - `refreshTokens` — uses a stored refresh token to mint a new access
 *     token without going through the browser flow again. Called on
 *     startup if `settings.tokens` is present so the user does not have
 *     to re-`/login` every CLI launch.
 *
 * `revokeRefreshToken` is best-effort — if the IdP returns 4xx, we eat
 * the error so `/logout` always succeeds locally even if the IdP session
 * is already gone.
 *
 * All HTTP work goes through {@link fetchWithDiagnostics} so failures
 * surface the underlying network/TLS/HTTP context (instead of Node's
 * generic `fetch failed`).
 */

import { APP_CLIENT_ID } from './config';
import { fetchWithDiagnostics, formatErrorChain } from './debug';
import type { TokenBundle } from '../settings/schema';

export interface ExchangeCodeOptions {
  authServerUrl: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
}

export interface RefreshTokensOptions {
  authServerUrl: string;
  refreshToken: string;
}

interface RawTokenResponse {
  access_token?: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

export async function exchangeCodeForTokens(opts: ExchangeCodeOptions): Promise<TokenBundle> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: APP_CLIENT_ID,
    code: opts.code,
    redirect_uri: opts.redirectUri,
    code_verifier: opts.codeVerifier,
  });
  return postTokenEndpoint(opts.authServerUrl, body, 'token exchange (authorization_code)');
}

export async function refreshTokens(opts: RefreshTokensOptions): Promise<TokenBundle> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: APP_CLIENT_ID,
    refresh_token: opts.refreshToken,
  });
  return postTokenEndpoint(opts.authServerUrl, body, 'token refresh');
}

export async function revokeRefreshToken(
  authServerUrl: string,
  refreshToken: string,
  log?: (message: string) => void
): Promise<void> {
  const url = `${stripTrailingSlash(authServerUrl)}/protocol/openid-connect/logout`;
  const body = new URLSearchParams({ client_id: APP_CLIENT_ID, refresh_token: refreshToken });
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
  } catch (err) {
    log?.(`logout revoke best-effort failed: ${formatErrorChain(err)}`);
  }
}

async function postTokenEndpoint(
  authServerUrl: string,
  body: URLSearchParams,
  stage: string
): Promise<TokenBundle> {
  const url = `${stripTrailingSlash(authServerUrl)}/protocol/openid-connect/token`;
  // Don't auto-throw on non-2xx — Keycloak returns JSON error bodies on
  // 400/401 that we want to parse and surface verbatim in the error.
  const previewBody = new URLSearchParams(body);
  redactSensitiveParams(previewBody);
  const { response } = await fetchWithDiagnostics(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    },
    { stage, throwOnHttpError: false, requestPreview: previewBody.toString() }
  );
  const json = (await response.json().catch(() => ({}))) as RawTokenResponse;
  if (!response.ok || json.error) {
    const detail =
      json.error_description ?? json.error ?? `${response.status} ${response.statusText}`;
    throw new Error(`${stage} failed: ${detail} (POST ${url})`);
  }
  if (!json.access_token) {
    throw new Error(`${stage}: response missing access_token (POST ${url})`);
  }
  const expiresIn = typeof json.expires_in === 'number' ? json.expires_in : 0;
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    tokenType: json.token_type ?? 'Bearer',
    expiresAt: Date.now() + expiresIn * 1000,
    scope: json.scope,
  };
}

function redactSensitiveParams(params: URLSearchParams): void {
  for (const key of ['code', 'code_verifier', 'refresh_token']) {
    if (params.has(key)) params.set(key, '<redacted>');
  }
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/$/, '');
}
