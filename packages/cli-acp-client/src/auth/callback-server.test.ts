import { afterEach, describe, expect, it } from 'vitest';
import { startCallbackServer, type CallbackServer } from './callback-server';

let server: CallbackServer | undefined;

afterEach(async () => {
  if (server) {
    await server.close();
    server = undefined;
  }
});

describe('startCallbackServer', () => {
  it('captures /callback?id=... as an access_request event and follows respondRedirect with 302', async () => {
    server = await startCallbackServer();
    const callbackPromise = server.awaitNext();
    const fetchPromise = fetch(`${server.redirectUri}?id=req-123&bodhi_flow=access_request`, {
      redirect: 'manual',
    });
    const pending = await callbackPromise;
    expect(pending.event).toEqual({
      kind: 'access_request',
      requestId: 'req-123',
      bodhiFlow: 'access_request',
    });
    pending.respondRedirect('https://idp.example.com/auth?x=1');
    const res = await fetchPromise;
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://idp.example.com/auth?x=1');
  });

  it('still accepts the legacy ?request_id= parameter for backwards compat', async () => {
    server = await startCallbackServer();
    const callbackPromise = server.awaitNext();
    const fetchPromise = fetch(`${server.redirectUri}?request_id=legacy-req-1`, {
      redirect: 'manual',
    });
    const pending = await callbackPromise;
    expect(pending.event).toMatchObject({ kind: 'access_request', requestId: 'legacy-req-1' });
    pending.respondRedirect('https://idp.example.com/auth');
    await fetchPromise;
  });

  it('captures /callback?code=&state= as a code event and renders success on respondSuccess', async () => {
    server = await startCallbackServer();
    const callbackPromise = server.awaitNext();
    const fetchPromise = fetch(`${server.redirectUri}?code=abc&state=xyz`);
    const pending = await callbackPromise;
    expect(pending.event).toEqual({ kind: 'code', code: 'abc', state: 'xyz' });
    pending.respondSuccess();
    const res = await fetchPromise;
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Login complete');
  });

  it('captures /callback?error=... as an error event', async () => {
    server = await startCallbackServer();
    const callbackPromise = server.awaitNext();
    const fetchPromise = fetch(
      `${server.redirectUri}?error=access_denied&error_description=User%20bailed`
    );
    const pending = await callbackPromise;
    expect(pending.event.kind).toBe('error');
    if (pending.event.kind === 'error') {
      expect(pending.event.error).toBe('access_denied');
      expect(pending.event.description).toBe('User bailed');
    }
    pending.respondError('failed');
    const res = await fetchPromise;
    expect(res.status).toBe(200);
  });

  it('exposes /retry as a separate signal', async () => {
    server = await startCallbackServer();
    const callbackPromise = server.awaitNext();
    const url = new URL(server.redirectUri);
    url.pathname = '/retry';
    const fetchPromise = fetch(url.toString(), { method: 'POST' });
    const pending = await callbackPromise;
    expect(pending.event).toEqual({ kind: 'retry' });
    pending.respondAck();
    const res = await fetchPromise;
    expect(res.status).toBe(200);
  });

  it('rejects unknown paths', async () => {
    server = await startCallbackServer();
    const url = new URL(server.redirectUri);
    url.pathname = '/nope';
    const res = await fetch(url.toString());
    expect(res.status).toBe(404);
  });

  it('queues a callback that arrives before awaitNext is called', async () => {
    server = await startCallbackServer();
    const fetchPromise = fetch(`${server.redirectUri}?id=queued-1&bodhi_flow=access_request`, {
      redirect: 'manual',
    });
    await new Promise(r => setTimeout(r, 30));
    const pending = await server.awaitNext();
    expect(pending.event).toEqual({
      kind: 'access_request',
      requestId: 'queued-1',
      bodhiFlow: 'access_request',
    });
    pending.respondRedirect('https://idp/auth');
    const res = await fetchPromise;
    expect(res.status).toBe(302);
  });
});
