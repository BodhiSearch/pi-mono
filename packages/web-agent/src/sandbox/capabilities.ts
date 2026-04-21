/**
 * Default capability handler implementation.
 *
 * Services capability requests coming out of the sandbox against the
 * main-thread vault port (ZenFS `/vault` mount driven from
 * `zenfs-provider.ts`) and, for `fetch`, the browser's live fetch
 * subject to normal CORS rules.
 *
 * Console capability is piped to the provided `onConsole` callback so
 * the bash-shim tool can aggregate stdout/stderr and surface them in
 * the tool result. We do NOT mirror skill logs to the host
 * `console.log` by default — skills can be noisy and we don't want
 * them polluting the DevTools console.
 */

import { fs } from '../worker-agent/fs/zenfs-provider';
import type { SandboxHostOptions } from './SandboxHost';
import type { SandboxCapabilityHandler } from './SandboxHost';
import type { SandboxCapabilityRequest, SandboxCapabilityResponse } from './types';

export interface BuildCapabilityHandlerOptions {
  /** Absolute prefix every vault path must sit beneath. Defaults to `/vault/`. */
  vaultMount?: string;
  /** Receives each console.log/error line the skill writes. */
  onConsole?: (stream: 'log' | 'error', text: string) => void;
  /**
   * If set, any host header already present on the user's page origin
   * that we don't want skills to piggyback is stripped. Purely defensive —
   * the null-origin iframe already can't read cookies.
   */
  fetchHeaderBlocklist?: string[];
  /** Overridable for tests. Defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
}

const DEFAULT_FETCH_HEADER_BLOCKLIST = ['authorization', 'cookie'];

function isUnderVault(path: string, mount: string): boolean {
  const normalisedMount = mount.endsWith('/') ? mount : `${mount}/`;
  return path === mount.replace(/\/$/, '') || path.startsWith(normalisedMount);
}

async function readdirEntries(path: string): Promise<string[]> {
  const entries = await fs.promises.readdir(path);
  return entries.map(e => (typeof e === 'string' ? e : (e as { name: string }).name));
}

async function readFileUtf8(path: string): Promise<string> {
  const buf = await fs.promises.readFile(path);
  return new TextDecoder().decode(buf as unknown as ArrayBuffer);
}

function error(requestId: string, message: string): SandboxCapabilityResponse {
  return { type: 'capability.error', requestId, ok: false, errorMessage: message };
}

/**
 * Build a capability handler closure that enforces:
 * - vault reads/writes/lists stay under the mount (no path traversal out)
 * - fetch strips `authorization` / `cookie` from the skill-supplied headers
 *   so a skill can't abuse bodhi credentials the host may have cached
 */
export function buildDefaultCapabilityHandler(
  options: BuildCapabilityHandlerOptions = {}
): SandboxCapabilityHandler {
  const vaultMount = options.vaultMount ?? '/vault';
  const blocklist = new Set(
    (options.fetchHeaderBlocklist ?? DEFAULT_FETCH_HEADER_BLOCKLIST).map(h => h.toLowerCase())
  );
  const fetchImpl = options.fetchImpl ?? fetch.bind(globalThis);

  return async function handle(
    request: SandboxCapabilityRequest
  ): Promise<SandboxCapabilityResponse> {
    switch (request.type) {
      case 'console': {
        options.onConsole?.(request.stream, request.text);
        return { type: 'console.result', requestId: request.requestId, ok: true };
      }
      case 'vault.readFile': {
        if (!isUnderVault(request.path, vaultMount)) {
          return error(request.requestId, `path outside vault: ${request.path}`);
        }
        try {
          const content = await readFileUtf8(request.path);
          return {
            type: 'vault.readFile.result',
            requestId: request.requestId,
            ok: true,
            content,
          };
        } catch (err) {
          return error(request.requestId, err instanceof Error ? err.message : String(err));
        }
      }
      case 'vault.writeFile': {
        if (!isUnderVault(request.path, vaultMount)) {
          return error(request.requestId, `path outside vault: ${request.path}`);
        }
        try {
          const lastSlash = request.path.lastIndexOf('/');
          if (lastSlash > 0) {
            const parent = request.path.slice(0, lastSlash);
            try {
              await fs.promises.mkdir(parent, { recursive: true });
            } catch {
              // best-effort
            }
          }
          await fs.promises.writeFile(request.path, request.content, { encoding: 'utf8' });
          return { type: 'vault.writeFile.result', requestId: request.requestId, ok: true };
        } catch (err) {
          return error(request.requestId, err instanceof Error ? err.message : String(err));
        }
      }
      case 'vault.ls': {
        if (!isUnderVault(request.path, vaultMount)) {
          return error(request.requestId, `path outside vault: ${request.path}`);
        }
        try {
          const entries = await readdirEntries(request.path);
          return {
            type: 'vault.ls.result',
            requestId: request.requestId,
            ok: true,
            entries,
          };
        } catch (err) {
          return error(request.requestId, err instanceof Error ? err.message : String(err));
        }
      }
      case 'fetch': {
        try {
          const init = request.init ?? {};
          const headers: Record<string, string> = {};
          if (init.headers) {
            for (const [k, v] of Object.entries(init.headers)) {
              if (blocklist.has(k.toLowerCase())) continue;
              headers[k] = v;
            }
          }
          const response = await fetchImpl(request.url, {
            method: init.method ?? 'GET',
            headers,
            body: init.body,
          });
          const respHeaders: Record<string, string> = {};
          response.headers.forEach((value, key) => {
            respHeaders[key.toLowerCase()] = value;
          });
          const body = await response.text();
          return {
            type: 'fetch.result',
            requestId: request.requestId,
            ok: true,
            status: response.status,
            statusText: response.statusText,
            headers: respHeaders,
            body,
          };
        } catch (err) {
          return error(request.requestId, err instanceof Error ? err.message : String(err));
        }
      }
    }
  };
}

export type { SandboxHostOptions };
