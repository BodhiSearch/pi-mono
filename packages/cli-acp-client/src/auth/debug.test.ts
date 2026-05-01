import { describe, expect, it, afterEach } from 'vitest';
import {
  fetchWithDiagnostics,
  formatErrorChain,
  FetchFailureError,
  HttpStatusError,
} from './debug';

const ORIGINAL_FETCH = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

describe('formatErrorChain', () => {
  it('renders a single error with name + message', () => {
    const result = formatErrorChain(new TypeError('boom'));
    expect(result).toBe('TypeError: boom');
  });

  it('walks the cause chain with indentation', () => {
    const inner = new Error('connect ECONNREFUSED 127.0.0.1:5173');
    Object.assign(inner, {
      code: 'ECONNREFUSED',
      errno: -61,
      syscall: 'connect',
      address: '127.0.0.1',
      port: 5173,
    });
    const wrapper = new TypeError('fetch failed', { cause: inner });
    const formatted = formatErrorChain(wrapper);
    expect(formatted).toMatch(/TypeError: fetch failed/);
    expect(formatted).toMatch(/caused by:/);
    expect(formatted).toMatch(/ECONNREFUSED/);
    expect(formatted).toMatch(/syscall=connect/);
    expect(formatted).toMatch(/address=127\.0\.0\.1/);
    expect(formatted).toMatch(/port=5173/);
  });

  it('handles non-Error causes gracefully', () => {
    const e = new Error('outer');
    Object.assign(e, { cause: 'a string cause' });
    expect(formatErrorChain(e)).toMatch(/a string cause/);
  });

  it('formats raw JSON-RPC error envelopes (ACP rejection shape)', () => {
    // ACP's ClientSideConnection rejects request promises with the
    // raw `{ code, message, data }` envelope from the JSON-RPC
    // response — not an Error instance. Without dedicated handling
    // these would render as `[object Object]`.
    const rpcEnvelope = {
      code: -32603,
      message: 'Internal error',
      data: { details: 'No model selected: send session/prompt with _meta.bodhi.modelId' },
    };
    const formatted = formatErrorChain(rpcEnvelope);
    expect(formatted).toMatch(/JSON-RPC error: Internal error \[code=-32603\]/);
    expect(formatted).toMatch(/No model selected/);
    expect(formatted).not.toMatch(/\[object Object\]/);
  });

  it('extracts ACP RequestError data.details onto its own line', () => {
    // ACP's RequestError exposes `code` + `data` as own properties on
    // an Error subclass; the headline carries `RequestError: <message>`
    // and details should appear indented underneath.
    class RequestErrorLike extends Error {
      code: number;
      data: unknown;
      constructor(code: number, message: string, data: unknown) {
        super(message);
        this.name = 'RequestError';
        this.code = code;
        this.data = data;
      }
    }
    const err = new RequestErrorLike(-32603, 'Internal error', {
      details: 'session/prompt failed: tool bash exited 127',
    });
    const formatted = formatErrorChain(err);
    expect(formatted).toMatch(/RequestError: Internal error/);
    expect(formatted).toMatch(/tool bash exited 127/);
  });
});

describe('fetchWithDiagnostics', () => {
  it('wraps network failures in FetchFailureError preserving the cause', async () => {
    const cause = new Error('connect ECONNREFUSED 127.0.0.1:1135');
    Object.assign(cause, { code: 'ECONNREFUSED', port: 1135 });
    globalThis.fetch = (async () => {
      throw new TypeError('fetch failed', { cause });
    }) as typeof fetch;
    await expect(
      fetchWithDiagnostics(
        'http://localhost:1135/bodhi/v1/apps/request-access',
        { method: 'POST', body: '{"app_client_id":"cli-acp-client"}' },
        { stage: 'request-access', requestPreview: '{"app_client_id":"cli-acp-client"}' }
      )
    ).rejects.toMatchObject({
      name: 'FetchFailureError',
      stage: 'request-access',
      url: 'http://localhost:1135/bodhi/v1/apps/request-access',
      method: 'POST',
    });
  });

  it('throws HttpStatusError with body on non-2xx by default', async () => {
    globalThis.fetch = (async () =>
      new Response('{"error":"not found"}', {
        status: 404,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;
    await expect(
      fetchWithDiagnostics('http://localhost:1135/missing', { method: 'GET' }, { stage: 'lookup' })
    ).rejects.toMatchObject({
      name: 'HttpStatusError',
      status: 404,
      url: 'http://localhost:1135/missing',
    });
  });

  it('returns the response when throwOnHttpError=false even on 4xx', async () => {
    globalThis.fetch = (async () =>
      new Response('{"error":"invalid_grant"}', {
        status: 400,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;
    const { response } = await fetchWithDiagnostics(
      'https://idp.example.com/protocol/openid-connect/token',
      { method: 'POST' },
      { stage: 'token exchange', throwOnHttpError: false }
    );
    expect(response.status).toBe(400);
  });

  it('exposes FetchFailureError + HttpStatusError as named classes', () => {
    expect(FetchFailureError.name).toBe('FetchFailureError');
    expect(HttpStatusError.name).toBe('HttpStatusError');
  });
});
