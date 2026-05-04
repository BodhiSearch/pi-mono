/**
 * OAuth 2.1 PKCE token endpoint glue against Keycloak.
 *
 * Slim version: only the initial code-for-token exchange. Refresh /
 * revoke are deferred — when tokens.json expires, the next launch
 * runs the full browser flow again.
 */

import { APP_CLIENT_ID } from "./config";

export interface ExchangeCodeOptions {
	authServerUrl: string;
	code: string;
	codeVerifier: string;
	redirectUri: string;
}

export interface TokenBundle {
	accessToken: string;
	refreshToken?: string;
	tokenType: string;
	expiresAt: number;
	scope?: string;
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
	const url = `${stripTrailingSlash(opts.authServerUrl)}/protocol/openid-connect/token`;
	const body = new URLSearchParams({
		grant_type: "authorization_code",
		client_id: APP_CLIENT_ID,
		code: opts.code,
		redirect_uri: opts.redirectUri,
		code_verifier: opts.codeVerifier,
	});
	const response = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body,
	});
	const json = (await response.json().catch(() => ({}))) as RawTokenResponse;
	if (!response.ok || json.error) {
		const detail = json.error_description ?? json.error ?? `${response.status} ${response.statusText}`;
		throw new Error(`token exchange failed: ${detail} (POST ${url})`);
	}
	if (!json.access_token) {
		throw new Error(`token exchange: response missing access_token (POST ${url})`);
	}
	const expiresIn = typeof json.expires_in === "number" ? json.expires_in : 0;
	return {
		accessToken: json.access_token,
		refreshToken: json.refresh_token,
		tokenType: json.token_type ?? "Bearer",
		expiresAt: Date.now() + expiresIn * 1000,
		scope: json.scope,
	};
}

function stripTrailingSlash(value: string): string {
	return value.replace(/\/$/, "");
}
