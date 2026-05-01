/**
 * Verbose error helpers used across the auth modules.
 *
 * The CLI is a developer/host tool, not an end-user product — every
 * failure should print enough context to diagnose without re-running
 * with a debugger. We:
 *
 *   - Walk `Error.cause` chains so `fetch failed` (Node's generic
 *     wrapper) does not swallow the underlying `ECONNREFUSED` /
 *     `ENOTFOUND` / TLS error.
 *   - Tag every fetch with the URL + method so the user can tell which
 *     hop in the OAuth dance failed.
 *   - Surface response bodies on non-2xx HTTP statuses (capped at 1KB
 *     so we don't dump opaque blobs).
 */

const MAX_BODY_PREVIEW_BYTES = 1024;

export function formatErrorChain(err: unknown): string {
  const lines: string[] = [];
  let current: unknown = err;
  let depth = 0;
  while (current && depth < 6) {
    const headPrefix = depth === 0 ? '' : `${' '.repeat(depth * 2)}↳ caused by: `;
    if (current instanceof Error) {
      const code = (current as Error & { code?: string }).code;
      const errno = (current as Error & { errno?: number }).errno;
      const syscall = (current as Error & { syscall?: string }).syscall;
      const address = (current as Error & { address?: string }).address;
      const port = (current as Error & { port?: number }).port;
      const tags: string[] = [];
      if (code) tags.push(`code=${code}`);
      if (errno !== undefined) tags.push(`errno=${errno}`);
      if (syscall) tags.push(`syscall=${syscall}`);
      if (address) tags.push(`address=${address}`);
      if (port !== undefined) tags.push(`port=${port}`);
      const tagStr = tags.length ? ` [${tags.join(' ')}]` : '';
      lines.push(`${headPrefix}${current.name}: ${current.message}${tagStr}`);
      // ACP's RequestError exposes JSON-RPC `code`/`data` as own
      // properties (see @agentclientprotocol/sdk acp.js). Surface
      // `data.details` (and any other primitive fields) inline so
      // the user sees the real failure reason.
      const rpcDetails = describeRpcData(
        (current as Error & { code?: number; data?: unknown }).data,
        depth + 1
      );
      if (rpcDetails.length > 0) {
        lines.push(...rpcDetails);
      }
      current = (current as Error & { cause?: unknown }).cause;
    } else if (looksLikeJsonRpcError(current)) {
      // ACP's `ClientSideConnection` rejects request promises with the
      // raw JSON-RPC error object (a plain `{ code, message, data }`
      // — *not* an Error instance), so we have to handle that shape
      // explicitly or it ends up as `[object Object]`.
      const e = current as { code?: number; message?: string; data?: unknown };
      const codeTag = typeof e.code === 'number' ? ` [code=${e.code}]` : '';
      lines.push(`${headPrefix}JSON-RPC error: ${e.message ?? 'unknown'}${codeTag}`);
      lines.push(...describeRpcData(e.data, depth + 1));
      break;
    } else {
      lines.push(`${' '.repeat(depth * 2)}↳ ${String(current)}`);
      break;
    }
    depth++;
  }
  return lines.join('\n');
}

function looksLikeJsonRpcError(x: unknown): boolean {
  if (!x || typeof x !== 'object') return false;
  const obj = x as Record<string, unknown>;
  return typeof obj.message === 'string' && typeof obj.code === 'number';
}

function describeRpcData(data: unknown, depth: number): string[] {
  if (data === undefined || data === null) return [];
  const indent = ' '.repeat(depth * 2);
  if (typeof data === 'string') return [`${indent}↳ ${data}`];
  if (typeof data !== 'object') return [`${indent}↳ ${String(data)}`];
  const obj = data as Record<string, unknown>;
  // Promote `details` (the convention used by the agent's prompt
  // driver and ext-method handlers) to the headline, then dump any
  // other primitive scalars on subsequent lines.
  const out: string[] = [];
  if (typeof obj.details === 'string') {
    out.push(`${indent}↳ ${obj.details}`);
  }
  for (const [key, value] of Object.entries(obj)) {
    if (key === 'details') continue;
    if (value === null || value === undefined) continue;
    if (typeof value === 'object') continue;
    out.push(`${indent}↳ ${key}=${String(value)}`);
  }
  return out;
}

/**
 * Concrete error type for outright network failures (DNS, connect,
 * TLS). Keeps `.message` short so the stack trace doesn't double up
 * with the cause chain — that chain is walked explicitly by
 * {@link formatErrorChain} when we render to the user.
 */
export class FetchFailureError extends Error {
  constructor(
    public readonly stage: string,
    public readonly url: string,
    public readonly method: string,
    cause: unknown,
    public readonly requestPreview?: string
  ) {
    super(`${stage} (${method} ${url}) failed at the network layer`, { cause });
    this.name = 'FetchFailureError';
  }
}

export class HttpStatusError extends Error {
  constructor(
    public readonly stage: string,
    public readonly url: string,
    public readonly method: string,
    public readonly status: number,
    public readonly statusText: string,
    public readonly responseBody?: string,
    public readonly responseContentType?: string
  ) {
    super(buildHttpStatusMessage(stage, method, url, status, statusText, responseBody));
    this.name = 'HttpStatusError';
  }
}

function buildHttpStatusMessage(
  stage: string,
  method: string,
  url: string,
  status: number,
  statusText: string,
  body?: string
): string {
  const head = `${stage} returned HTTP ${status} ${statusText}`;
  const tail = body
    ? `\n  ${method} ${url}\n  body: ${truncateBody(body)}`
    : `\n  ${method} ${url}`;
  return `${head}${tail}`;
}

function truncateBody(body: string): string {
  if (body.length <= MAX_BODY_PREVIEW_BYTES) return body;
  return `${body.slice(0, MAX_BODY_PREVIEW_BYTES)}… (${body.length} bytes total)`;
}

export interface FetchWithDiagnosticsOptions {
  /**
   * Human-readable label of the operation we're performing, included
   * verbatim in any error message ("request-access", "token exchange",
   * "access-request status").
   */
  stage: string;
  /** Optional body preview to include if the request fails outright. */
  requestPreview?: string;
  /**
   * Whether to throw on non-2xx. When false, callers handle the response
   * themselves and we only catch network-level errors.
   */
  throwOnHttpError?: boolean;
}

export interface FetchDiagnosticsResult {
  response: Response;
  bodyText: string | undefined;
}

export async function fetchWithDiagnostics(
  url: string,
  init: RequestInit,
  opts: FetchWithDiagnosticsOptions
): Promise<FetchDiagnosticsResult> {
  const method = (init.method ?? 'GET').toUpperCase();
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (err) {
    throw new FetchFailureError(opts.stage, url, method, err, opts.requestPreview);
  }
  const throwOnHttpError = opts.throwOnHttpError ?? true;
  if (throwOnHttpError && !response.ok) {
    const bodyText = await safeReadText(response);
    throw new HttpStatusError(
      opts.stage,
      url,
      method,
      response.status,
      response.statusText,
      bodyText,
      response.headers.get('content-type') ?? undefined
    );
  }
  return { response, bodyText: undefined };
}

async function safeReadText(res: Response): Promise<string | undefined> {
  try {
    const text = await res.text();
    return text.length > 0 ? text : undefined;
  } catch {
    return undefined;
  }
}
