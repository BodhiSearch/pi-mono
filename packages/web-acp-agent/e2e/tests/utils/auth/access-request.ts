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
  bodhiUrl: string;
  redirectUri: string;
  requestedRole?: UserScope;
  requested?: RequestedResources;
}

export interface RequestAccessResponse {
  requestId: string;
  reviewUrl: string;
  status: string;
}

export interface AccessRequestStatus {
  id: string;
  status: 'draft' | 'approved' | 'denied' | 'failed' | 'expired';
  requestedRole: UserScope;
  approvedRole?: UserScope;
  accessRequestScope?: string;
}

const REQUEST_ACCESS_PATH = '/bodhi/v1/apps/request-access';
const ACCESS_REQUEST_STATUS_PATH = '/bodhi/v1/apps/access-requests';

export async function requestAccess(opts: RequestAccessOptions): Promise<RequestAccessResponse> {
  const url = `${stripTrailingSlash(opts.bodhiUrl)}${REQUEST_ACCESS_PATH}`;
  const body = {
    app_client_id: APP_CLIENT_ID,
    flow_type: 'redirect' as FlowType,
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
