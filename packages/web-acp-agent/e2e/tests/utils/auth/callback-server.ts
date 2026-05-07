import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export type CallbackEvent =
  | { kind: 'access_request'; requestId: string; bodhiFlow?: string }
  | { kind: 'code'; code: string; state: string }
  | { kind: 'error'; error: string; description?: string; state?: string }
  | { kind: 'retry' };

export interface PendingCallback {
  event: CallbackEvent;
  respondSuccess(): void;
  respondRedirect(url: string): void;
  respondError(message: string): void;
  respondAck(): void;
}

export interface CallbackServer {
  readonly port: number;
  readonly redirectUri: string;
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
  const bodhiFlow = url.searchParams.get('bodhi_flow') ?? undefined;
  const requestId = url.searchParams.get('id') ?? url.searchParams.get('request_id');
  if (requestId) {
    deliver(makePending(res, { kind: 'access_request', requestId, bodhiFlow }));
    return;
  }
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
<html><head><meta charset="utf-8"><title>web-acp-agent e2e</title></head>
<body><h1>Login complete</h1><p>You can close this tab.</p></body></html>`;
}

function renderErrorPage(error: string): string {
  const safeError = escapeHtml(error);
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>web-acp-agent e2e — login error</title></head>
<body><h1>Login failed</h1><p>${safeError}</p></body></html>`;
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
