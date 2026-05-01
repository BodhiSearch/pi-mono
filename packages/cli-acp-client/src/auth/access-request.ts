/**
 * BodhiApp access-request endpoints.
 *
 * Mirrors what `@bodhiapp/bodhi-js`'s `DirectWebClient.login` does in the
 * browser, but for our redirect-based CLI flow:
 *
 *   1. POST `/bodhi/v1/apps/request-access` with `flow_type: "redirect"`
 *      and our local callback URL — Bodhi returns
 *      `{ id, status: "draft", review_url }`.
 *   2. The user opens `review_url`, signs in to Keycloak (if not
 *      already), reviews the requested resources, and approves.
 *   3. Bodhi then redirects the browser to our `redirect_url` with
 *      `?request_id=<id>`. The CLI fetches
 *      `/bodhi/v1/apps/access-requests/{id}?app_client_id=...` to read
 *      the approved scope (`access_request_scope`).
 *   4. The CLI then performs OAuth 2.1 PKCE on Keycloak directly using
 *      that scope. The shape of (3) and (4) is owned by `login-flow.ts`.
 *
 * Both endpoints are anonymous (no Authorization header). All failures
 * route through `debug.ts` so the user sees the underlying error chain
 * (DNS / TCP / HTTP status / response body) instead of a bare
 * `fetch failed`.
 */

import { APP_CLIENT_ID } from './config';
import { fetchWithDiagnostics } from './debug';

export type FlowType = 'redirect' | 'popup';
export type UserScope = 'scope_user_user' | 'scope_user_power_user';

export interface RequestedMcpServer {
  url: string;
}

export interface RequestedResources {
  mcp_servers?: RequestedMcpServer[];
}

export interface RequestAccessOptions {
  /** Bodhi base URL, e.g. `http://localhost:1135`. */
  bodhiUrl: string;
  /** Local callback redirect URI we host. */
  redirectUri: string;
  /** Role requested for this app (defaults to `scope_user_user`). */
  requestedRole?: UserScope;
  /** Resources we want approved. */
  requested?: RequestedResources;
}

export interface RequestAccessResponse {
  /** Opaque ID we bind into the authorize URL via `access_request:<id>`. */
  requestId: string;
  /** BodhiApp URL where the user reviews + approves the consent. */
  reviewUrl: string;
  /** Status returned with the create response (always `"draft"`). */
  status: string;
}

export interface AccessRequestStatus {
  id: string;
  status: 'draft' | 'approved' | 'denied' | 'failed' | 'expired';
  requestedRole: UserScope;
  approvedRole?: UserScope;
  /**
   * The dynamic OAuth scope assigned to this approved request. Typically
   * of the form `access_request:<id>` and is what Keycloak validates on
   * token issuance. Absent until the status is `approved`.
   */
  accessRequestScope?: string;
}

const REQUEST_ACCESS_PATH = '/bodhi/v1/apps/request-access';
const ACCESS_REQUEST_STATUS_PATH = '/bodhi/v1/apps/access-requests';

export async function requestAccess(opts: RequestAccessOptions): Promise<RequestAccessResponse> {
  const url = `${stripTrailingSlash(opts.bodhiUrl)}${REQUEST_ACCESS_PATH}`;
  const body = {
    app_client_id: APP_CLIENT_ID,
    flow_type: 'redirect' as FlowType,
    // BodhiApp's review UI requires `bodhi_flow=access_request` on the
    // redirect URL it bounces the browser to — without it the UI returns
    // `?error=missing_params` instead of `?id=<access-request-id>`.
    // This mirrors what `@bodhiapp/bodhi-js-core` (the SDK we'd use in
    // the browser) appends inside its `AccessRequestBuilder.build()`.
    redirect_url: appendQuery(opts.redirectUri, 'bodhi_flow', 'access_request'),
    requested_role: opts.requestedRole ?? 'scope_user_user',
    requested: {
      ...(opts.requested ?? {}),
      version: '1' as const,
    },
  };
  const requestPreview = JSON.stringify(body);
  const { response } = await fetchWithDiagnostics(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: requestPreview,
    },
    { stage: 'request-access', requestPreview }
  );
  const json = (await response.json()) as Record<string, unknown>;
  const requestId = pickString(json, 'id') ?? pickString(json, 'request_id');
  const reviewUrl = pickString(json, 'review_url') ?? pickString(json, 'reviewUrl');
  const status = pickString(json, 'status') ?? 'draft';
  if (!requestId || !reviewUrl) {
    throw new Error(`request-access: response missing id/review_url; got ${JSON.stringify(json)}`);
  }
  return { requestId, reviewUrl, status };
}

export async function getAccessRequestStatus(
  bodhiUrl: string,
  requestId: string
): Promise<AccessRequestStatus> {
  const url = new URL(`${stripTrailingSlash(bodhiUrl)}${ACCESS_REQUEST_STATUS_PATH}/${requestId}`);
  url.searchParams.set('app_client_id', APP_CLIENT_ID);
  const { response } = await fetchWithDiagnostics(
    url.toString(),
    { method: 'GET', headers: { Accept: 'application/json' } },
    { stage: 'access-request status' }
  );
  const json = (await response.json()) as Record<string, unknown>;
  const id = pickString(json, 'id') ?? requestId;
  const status = (pickString(json, 'status') ?? 'draft') as AccessRequestStatus['status'];
  const requestedRole = (pickString(json, 'requested_role') ?? 'scope_user_user') as UserScope;
  const approvedRole = pickString(json, 'approved_role') as UserScope | undefined;
  const accessRequestScope = pickString(json, 'access_request_scope');
  return { id, status, requestedRole, approvedRole, accessRequestScope };
}

function pickString(obj: Record<string, unknown>, key: string): string | undefined {
  const val = obj[key];
  return typeof val === 'string' && val.length > 0 ? val : undefined;
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/$/, '');
}

function appendQuery(url: string, key: string, value: string): string {
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
}
