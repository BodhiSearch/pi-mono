import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Ephemeral HTTP server that hosts the OAuth callback endpoint the user's
 * browser is redirected to. Bound to `127.0.0.1` on a fixed port (default
 * 5173 — see `auth/config.ts`).
 *
 * The login flow is intentionally two-phase:
 *
 *   1. **Bodhi access-request callback** — after the user reviews +
 *      approves the consent, Bodhi redirects the browser back to our
 *      callback. Per BodhiApp's review UI contract (and what
 *      `@bodhiapp/bodhi-js-core`'s in-browser handler expects), the
 *      query string carries `?id=<access-request-id>` together with the
 *      `bodhi_flow=access_request` marker we appended on the way in.
 *      The CLI fetches `/bodhi/v1/apps/access-requests/{id}`, asserts
 *      the request was approved, then issues a 302 to Keycloak's
 *      authorize endpoint with `scope = openid profile email roles
 *      <access_request_scope>`.
 *
 *   2. **OAuth code callback** — Keycloak then redirects back with
 *      `?code=...&state=...`, which the CLI exchanges for tokens.
 *
 * To support both phases the server emits each callback as a
 * {@link PendingCallback} via {@link CallbackServer.awaitNext}. The caller
 * decides how to respond (`respondRedirect` for phase 1, `respondSuccess`
 * for phase 2). This keeps the response open while the CLI does async
 * work (status lookup, Keycloak URL construction).
 *
 * `POST /retry` is a separate signal the in-browser error page can use to
 * ask the CLI to restart the flow.
 */

export type CallbackEvent =
  | { kind: 'access_request'; requestId: string; bodhiFlow?: string }
  | { kind: 'code'; code: string; state: string }
  | { kind: 'error'; error: string; description?: string; state?: string }
  | { kind: 'retry' };

export interface PendingCallback {
  event: CallbackEvent;
  /** 200 OK + success HTML — use after the final phase. */
  respondSuccess(): void;
  /** 302 Location: <url> — use after phase 1 to bounce the browser. */
  respondRedirect(url: string): void;
  /** 200 OK + the supplied error HTML — use when a phase fails. */
  respondError(message: string): void;
  /** Already-resolved acknowledgement (used by `/retry`). */
  respondAck(): void;
}

export interface CallbackServer {
  readonly port: number;
  readonly redirectUri: string;
  /** Wait for the next callback hit. Resolves with a pending response. */
  awaitNext(timeoutMs?: number): Promise<PendingCallback>;
  close(): Promise<void>;
}

export interface StartCallbackServerOptions {
  port?: number;
}

export async function startCallbackServer(
  opts: StartCallbackServerOptions = {}
): Promise<CallbackServer> {
  type Pending = (cb: PendingCallback) => void;
  const waiters: Pending[] = [];
  const queued: PendingCallback[] = [];

  function deliver(cb: PendingCallback): void {
    const next = waiters.shift();
    if (next) {
      next(cb);
      return;
    }
    queued.push(cb);
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/callback') {
      handleCallbackGet(url, res, deliver);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/retry') {
      handleRetryPost(res, deliver);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, '127.0.0.1', () => resolve());
  });

  const address = server.address() as AddressInfo;
  const port = address.port;
  const redirectUri = `http://localhost:${port}/callback`;

  return {
    port,
    redirectUri,
    awaitNext(timeoutMs?: number): Promise<PendingCallback> {
      const queuedCb = queued.shift();
      if (queuedCb) return Promise.resolve(queuedCb);
      const wait = new Promise<PendingCallback>(resolve => waiters.push(resolve));
      if (timeoutMs && timeoutMs > 0) {
        return Promise.race([
          wait,
          new Promise<PendingCallback>((_, reject) =>
            setTimeout(() => reject(new Error('callback timeout')), timeoutMs)
          ),
        ]);
      }
      return wait;
    },
    close: () => closeServer(server),
  };
}

function handleCallbackGet(
  url: URL,
  res: ServerResponse<IncomingMessage>,
  deliver: (cb: PendingCallback) => void
): void {
  const error = url.searchParams.get('error');
  if (error) {
    const description = url.searchParams.get('error_description') ?? undefined;
    const state = url.searchParams.get('state') ?? undefined;
    deliver(makePending(res, { kind: 'error', error, description, state }));
    return;
  }
  // Phase 1: BodhiApp's review UI bounces back with `?id=<access-request-id>`
  // (the `bodhi_flow=access_request` marker we passed in the original
  // redirect_url is what tells the UI to use this exact format).
  // We accept legacy `?request_id=` too, in case the BodhiApp version
  // hasn't been updated.
  const bodhiFlow = url.searchParams.get('bodhi_flow') ?? undefined;
  const requestId = url.searchParams.get('id') ?? url.searchParams.get('request_id');
  if (requestId) {
    deliver(makePending(res, { kind: 'access_request', requestId, bodhiFlow }));
    return;
  }
  // Phase 2: Keycloak's authorization callback.
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (code && state) {
    deliver(makePending(res, { kind: 'code', code, state }));
    return;
  }
  const queryDump = url.searchParams.toString() || '<empty>';
  const err: CallbackEvent = {
    kind: 'error',
    error: 'missing_params',
    description: `callback received with no recognised params (query: ${queryDump})`,
  };
  deliver(makePending(res, err));
}

function handleRetryPost(
  res: ServerResponse<IncomingMessage>,
  deliver: (cb: PendingCallback) => void
): void {
  deliver(makePending(res, { kind: 'retry' }));
}

function makePending(res: ServerResponse<IncomingMessage>, event: CallbackEvent): PendingCallback {
  let responded = false;
  const guard = (fn: () => void): void => {
    if (responded) return;
    responded = true;
    fn();
  };
  return {
    event,
    respondSuccess: () =>
      guard(() => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(renderSuccessPage());
      }),
    respondRedirect: (url: string) =>
      guard(() => {
        res.writeHead(302, { Location: url });
        res.end();
      }),
    respondError: (message: string) =>
      guard(() => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(renderErrorPage(message));
      }),
    respondAck: () =>
      guard(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      }),
  };
}

function renderSuccessPage(): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>cli-acp-client</title>
<style>body{font-family:system-ui,sans-serif;margin:3rem auto;max-width:32rem;text-align:center;color:#222}</style>
</head><body>
<h1>Login complete</h1>
<p>You can close this tab and return to the terminal.</p>
</body></html>`;
}

function renderErrorPage(error: string, description?: string): string {
  const safeError = escapeHtml(error);
  const safeDescription = description ? escapeHtml(description) : '';
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>cli-acp-client — login error</title>
<style>
body{font-family:system-ui,sans-serif;margin:3rem auto;max-width:32rem;color:#222}
button{padding:.6rem 1rem;border:1px solid #888;border-radius:.4rem;background:#fafafa;cursor:pointer;font:inherit}
</style></head><body>
<h1>Login failed</h1>
<p><strong>${safeError}</strong></p>
${safeDescription ? `<p>${safeDescription}</p>` : ''}
<p>You can retry the access-request flow from here, or return to the terminal and run <code>/login</code> again.</p>
<button id="retry">Retry access request</button>
<p id="status" style="margin-top:1rem;color:#666"></p>
<script>
document.getElementById('retry').addEventListener('click', async () => {
  document.getElementById('status').textContent = 'Restarting flow…';
  try {
    await fetch('/retry', { method: 'POST' });
    document.getElementById('status').textContent = 'Triggered. Return to the terminal.';
  } catch (e) {
    document.getElementById('status').textContent = 'Could not reach the CLI. Please retry from the terminal.';
  }
});
</script>
</body></html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function closeServer(server: Server): Promise<void> {
  return new Promise(resolve => {
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
}
