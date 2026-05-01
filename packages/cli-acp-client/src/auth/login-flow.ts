/**
 * End-to-end orchestration of the BodhiApp access-request + OAuth 2.1 PKCE
 * login flow for a CLI client.
 *
 * The flow is intrinsically two-phase because Bodhi separates **resource
 * consent** (review/approve at `review_url`) from **identity assertion**
 * (Keycloak OAuth):
 *
 *   1. Bind a local callback server on a free port.
 *   2. POST `/bodhi/v1/apps/request-access` with `flow_type: "redirect"`,
 *      `redirect_url: <local callback>`, the requested role, and the
 *      requested resources.
 *   3. Open the browser at the returned `review_url`. The user signs in
 *      to Bodhi (which uses Keycloak under the hood), reviews, approves.
 *   4. Bodhi redirects to our callback with `?request_id=<id>`. The CLI
 *      fetches the status to read `access_request_scope` (and ignores
 *      lingering polling — the redirect already implies approval).
 *   5. The CLI builds a Keycloak authorize URL with the access-request
 *      scope and PKCE challenge, then **responds to the still-open
 *      browser request with a 302** to that URL. The browser follows
 *      automatically.
 *   6. Keycloak's SSO cookie is already set (the user just signed in via
 *      Bodhi), so it immediately redirects back to our callback with
 *      `?code=...&state=...`.
 *   7. The CLI exchanges the code for tokens and renders a "you can close
 *      this tab" page.
 *
 * Returns the final token bundle. The caller persists tokens to settings
 * and pushes them to the agent via ACP `authenticate`.
 */

import {
  APP_CLIENT_ID,
  buildScopeString,
  DEFAULT_AUTH_SERVER_URL,
  DEFAULT_CALLBACK_PORT,
} from './config';
import { createPkcePair, type PkcePair } from './pkce';
import {
  getAccessRequestStatus,
  requestAccess,
  type AccessRequestStatus,
  type RequestedResources,
  type UserScope,
} from './access-request';
import { type CallbackServer, type PendingCallback, startCallbackServer } from './callback-server';
import { defaultBrowserOpener, type BrowserOpener } from './browser-opener';
import { formatErrorChain } from './debug';
import { exchangeCodeForTokens } from './token-exchange';
import type { TokenBundle } from '../settings/schema';

export interface LoginFlowOptions {
  bodhiUrl: string;
  authServerUrl?: string;
  /** Defaults to `scope_user_user`. */
  requestedRole?: UserScope;
  /** Resources to request approval for (currently `mcp_servers`). */
  requested?: RequestedResources;
  /** Maximum total time to wait for the user to complete the flow. */
  timeoutMs?: number;
  /**
   * Local port for the OAuth callback HTTP server. Defaults to
   * {@link DEFAULT_CALLBACK_PORT} (the same port web-acp's Vite dev
   * server uses, since Keycloak is configured to allow that exact
   * `redirect_uri`). Pass 0 to ask the OS for a random free port —
   * useful in tests, but the IdP will reject the redirect unless that
   * port is in the client's allow-list.
   */
  callbackPort?: number;
  /** Override the browser opener (e2e harness uses a Playwright-driven one). */
  opener?: BrowserOpener;
  /** Override the callback server factory (tests inject a fake). */
  startCallbackServer?: (port?: number) => Promise<CallbackServer>;
  /** Optional log function for progress events. */
  log?: (message: string) => void;
}

export interface LoginFlowResult {
  tokens: TokenBundle;
  /** The access-request id approved during the flow (for diagnostics). */
  accessRequestId: string;
  /** The dynamic OAuth scope assigned to that approval. */
  accessRequestScope?: string;
  bodhiUrl: string;
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

export async function runLoginFlow(opts: LoginFlowOptions): Promise<LoginFlowResult> {
  const authServerUrl = opts.authServerUrl ?? DEFAULT_AUTH_SERVER_URL;
  const opener = opts.opener ?? defaultBrowserOpener;
  const callbackPort = opts.callbackPort ?? DEFAULT_CALLBACK_PORT;
  const start = opts.startCallbackServer ?? (port => startCallbackServer({ port }));
  const log = opts.log ?? (() => {});
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  log(`bodhiUrl=${opts.bodhiUrl} authServerUrl=${authServerUrl}`);
  log(`Binding OAuth callback server on 127.0.0.1:${callbackPort}`);
  let callbackServer: CallbackServer;
  try {
    callbackServer = await start(callbackPort);
  } catch (err) {
    throw new Error(
      `Failed to start callback server on port ${callbackPort}.\n  ${formatErrorChain(err)}\n` +
        `  hint: another process may be bound to ${callbackPort}; ` +
        `set settings.callbackPort to override or stop the conflicting service.`,
      { cause: err }
    );
  }
  log(`Listening for OAuth callback on ${callbackServer.redirectUri}`);

  try {
    while (true) {
      const pkce = createPkcePair();
      log(`POST ${opts.bodhiUrl}/bodhi/v1/apps/request-access (client=${APP_CLIENT_ID})`);
      const access = await requestAccess({
        bodhiUrl: opts.bodhiUrl,
        redirectUri: callbackServer.redirectUri,
        requestedRole: opts.requestedRole,
        requested: opts.requested,
      });
      log(`Access request submitted (id=${access.requestId}); review at ${access.reviewUrl}`);

      await opener.open(access.reviewUrl);
      log(`Opened browser at ${access.reviewUrl}`);

      const phase1 = await callbackServer.awaitNext(timeoutMs);
      const phase1Result = await handlePhase1({
        phase1,
        bodhiUrl: opts.bodhiUrl,
        authServerUrl,
        pkce,
        redirectUri: callbackServer.redirectUri,
        accessRequestId: access.requestId,
        log,
      });
      if (phase1Result.kind === 'retry') {
        log('User requested retry; restarting access-request flow');
        continue;
      }
      if (phase1Result.kind === 'abort') {
        throw new Error(phase1Result.message);
      }

      const phase2 = await callbackServer.awaitNext(timeoutMs);
      if (phase2.event.kind === 'retry') {
        phase2.respondAck();
        continue;
      }
      if (phase2.event.kind === 'error') {
        const message = formatError(phase2.event.error, phase2.event.description);
        phase2.respondError(message);
        throw new Error(`OAuth error: ${message}`);
      }
      if (phase2.event.kind !== 'code') {
        phase2.respondError('expected ?code=...&state=... callback');
        throw new Error(`unexpected callback after authorize: ${phase2.event.kind}`);
      }
      if (phase2.event.state !== pkce.state) {
        phase2.respondError('state mismatch — possible CSRF, aborting');
        throw new Error('callback state mismatch — possible CSRF, aborting login');
      }

      const tokens = await exchangeCodeForTokens({
        authServerUrl,
        code: phase2.event.code,
        codeVerifier: pkce.verifier,
        redirectUri: callbackServer.redirectUri,
      });
      phase2.respondSuccess();
      log('Login successful, tokens received');
      return {
        tokens,
        accessRequestId: access.requestId,
        accessRequestScope: phase1Result.accessRequestScope,
        bodhiUrl: opts.bodhiUrl,
      };
    }
  } finally {
    await callbackServer.close();
  }
}

interface Phase1Outcome {
  kind: 'redirected' | 'retry' | 'abort';
  message?: string;
  accessRequestScope?: string;
}

interface HandlePhase1Args {
  phase1: PendingCallback;
  bodhiUrl: string;
  authServerUrl: string;
  pkce: PkcePair;
  redirectUri: string;
  accessRequestId: string;
  log: (message: string) => void;
}

async function handlePhase1(args: HandlePhase1Args): Promise<Phase1Outcome> {
  const { phase1, bodhiUrl, authServerUrl, pkce, redirectUri, accessRequestId, log } = args;
  if (phase1.event.kind === 'retry') {
    phase1.respondAck();
    return { kind: 'retry' };
  }
  if (phase1.event.kind === 'error') {
    const message = formatError(phase1.event.error, phase1.event.description);
    phase1.respondError(message);
    return { kind: 'abort', message: `Bodhi access-request error: ${message}` };
  }
  if (phase1.event.kind !== 'access_request') {
    phase1.respondError(`unexpected phase 1 callback (kind=${phase1.event.kind})`);
    return { kind: 'abort', message: `unexpected phase 1 callback: ${phase1.event.kind}` };
  }
  if (phase1.event.requestId !== accessRequestId) {
    phase1.respondError('access-request id mismatch');
    return { kind: 'abort', message: 'access-request id mismatch in callback' };
  }
  if (phase1.event.bodhiFlow && phase1.event.bodhiFlow !== 'access_request') {
    log(`Note: callback received unexpected bodhi_flow=${phase1.event.bodhiFlow}`);
  }

  let status: AccessRequestStatus;
  try {
    status = await getAccessRequestStatus(bodhiUrl, accessRequestId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    phase1.respondError(`could not fetch access-request status: ${message}`);
    return { kind: 'abort', message };
  }
  if (status.status !== 'approved') {
    phase1.respondError(`access request not approved (status=${status.status})`);
    return { kind: 'abort', message: `access request status: ${status.status}` };
  }

  const authorizeUrl = buildAuthorizeUrl({
    authServerUrl,
    accessRequestId,
    accessRequestScope: status.accessRequestScope,
    pkce,
    redirectUri,
  });
  log(`Phase 1 OK — bouncing browser to ${authorizeUrl}`);
  phase1.respondRedirect(authorizeUrl);
  return { kind: 'redirected', accessRequestScope: status.accessRequestScope };
}

export interface BuildAuthorizeUrlOptions {
  authServerUrl: string;
  accessRequestId: string;
  /** Verbatim `access_request_scope` from Bodhi's status response. */
  accessRequestScope?: string;
  pkce: PkcePair;
  redirectUri: string;
}

export function buildAuthorizeUrl(opts: BuildAuthorizeUrlOptions): string {
  const url = new URL(`${stripTrailingSlash(opts.authServerUrl)}/protocol/openid-connect/auth`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', APP_CLIENT_ID);
  url.searchParams.set('redirect_uri', opts.redirectUri);
  url.searchParams.set('scope', buildScopeString(opts.accessRequestId, opts.accessRequestScope));
  url.searchParams.set('state', opts.pkce.state);
  url.searchParams.set('code_challenge', opts.pkce.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

function formatError(error: string, description?: string): string {
  return description ? `${error}: ${description}` : error;
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/$/, '');
}
