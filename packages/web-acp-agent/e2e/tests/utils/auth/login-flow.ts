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
import { formatErrorChain } from './debug';
import { exchangeCodeForTokens } from './token-exchange';
import type { TokenBundle } from './types';

export interface BrowserOpener {
  open(url: string): Promise<void>;
}

export interface LoginFlowOptions {
  bodhiUrl: string;
  authServerUrl?: string;
  requestedRole?: UserScope;
  requested?: RequestedResources;
  timeoutMs?: number;
  callbackPort?: number;
  /** Required: a Playwright-driven opener. */
  opener: BrowserOpener;
  startCallbackServer?: (port?: number) => Promise<CallbackServer>;
  log?: (message: string) => void;
}

export interface LoginFlowResult {
  tokens: TokenBundle;
  accessRequestId: string;
  accessRequestScope?: string;
  bodhiUrl: string;
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

export async function runLoginFlow(opts: LoginFlowOptions): Promise<LoginFlowResult> {
  const authServerUrl = opts.authServerUrl ?? DEFAULT_AUTH_SERVER_URL;
  const opener = opts.opener;
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
        `  hint: another process may be bound to ${callbackPort}.`,
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
