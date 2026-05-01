import { describe, expect, it, afterEach } from 'vitest';
import { requestAccess, getAccessRequestStatus } from './access-request';
import { APP_CLIENT_ID } from './config';

const ORIGINAL_FETCH = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

describe('requestAccess', () => {
  it('POSTs the documented body and appends bodhi_flow=access_request to redirect_url', async () => {
    let capturedUrl = '';
    let capturedBody: unknown = null;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      capturedUrl = url;
      capturedBody = JSON.parse(String(init.body));
      return new Response(
        JSON.stringify({
          id: 'req-abc',
          status: 'draft',
          review_url: 'http://localhost:1135/ui/apps/access-requests/review?id=req-abc',
        }),
        { status: 201, headers: { 'content-type': 'application/json' } }
      );
    }) as typeof fetch;

    const result = await requestAccess({
      bodhiUrl: 'http://localhost:1135',
      redirectUri: 'http://localhost:5173/callback',
      requestedRole: 'scope_user_user',
      requested: { mcp_servers: [{ url: 'http://mcp.example.com' }] },
    });

    expect(capturedUrl).toBe('http://localhost:1135/bodhi/v1/apps/request-access');
    expect(capturedBody).toEqual({
      app_client_id: APP_CLIENT_ID,
      flow_type: 'redirect',
      redirect_url: 'http://localhost:5173/callback?bodhi_flow=access_request',
      requested_role: 'scope_user_user',
      requested: { version: '1', mcp_servers: [{ url: 'http://mcp.example.com' }] },
    });
    expect(result).toEqual({
      requestId: 'req-abc',
      reviewUrl: 'http://localhost:1135/ui/apps/access-requests/review?id=req-abc',
      status: 'draft',
    });
  });

  it('appends bodhi_flow as `&bodhi_flow=...` when redirect_uri already has a query', async () => {
    let capturedBody: { redirect_url?: string } = {};
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ id: 'r', status: 'draft', review_url: 'http://x/y' }), {
        status: 201,
      });
    }) as typeof fetch;

    await requestAccess({
      bodhiUrl: 'http://localhost:1135',
      redirectUri: 'http://localhost:5173/callback?foo=1',
    });

    expect(capturedBody.redirect_url).toBe(
      'http://localhost:5173/callback?foo=1&bodhi_flow=access_request'
    );
  });
});

describe('getAccessRequestStatus', () => {
  it('GETs /bodhi/v1/apps/access-requests/{id} with app_client_id and parses response', async () => {
    let capturedUrl = '';
    globalThis.fetch = (async (url: string) => {
      capturedUrl = url;
      return new Response(
        JSON.stringify({
          id: 'req-abc',
          status: 'approved',
          requested_role: 'scope_user_user',
          approved_role: 'scope_user_user',
          access_request_scope: 'access_request:req-abc',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }) as typeof fetch;

    const status = await getAccessRequestStatus('http://localhost:1135', 'req-abc');
    expect(capturedUrl).toBe(
      `http://localhost:1135/bodhi/v1/apps/access-requests/req-abc?app_client_id=${encodeURIComponent(APP_CLIENT_ID)}`
    );
    expect(status).toEqual({
      id: 'req-abc',
      status: 'approved',
      requestedRole: 'scope_user_user',
      approvedRole: 'scope_user_user',
      accessRequestScope: 'access_request:req-abc',
    });
  });
});
