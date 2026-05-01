/**
 * `AppContext` is the singleton state object every slash command sees.
 *
 * It owns:
 *   - the embedded ACP host (which carries the agent + AcpClient),
 *   - the persisted settings store,
 *   - the renderer (so commands can emit messages back to the UI),
 *   - mutable runtime state: current sessionId, current modelId, last
 *     known tokens, last connection status.
 *
 * Commands do not import the embedded host or settings store directly —
 * they read/write through the context so a test can build a context
 * with a fake host and renderer without touching the filesystem.
 */

import type { McpServerHttp } from '@agentclientprotocol/sdk';
import type { EmbeddedHost } from '../acp/embedded-host';
import type { AcpClient } from '../acp/client';
import type { BrowserOpener } from '../auth/browser-opener';
import type { SettingsStore } from '../settings/store';
import type { Settings, TokenBundle } from '../settings/schema';
import type { ConnectionStatus, Renderer } from './types';

export interface AppContext {
  readonly settings: SettingsStore;
  readonly host: EmbeddedHost;
  readonly client: AcpClient;
  readonly renderer: Renderer;
  readonly opener: BrowserOpener;
  readonly cwd: string;
  /**
   * Current ACP session id, set by `session/new` / `session/load`. Most
   * commands implicitly create one if absent (e.g. on the first prompt).
   */
  sessionId: string | null;
  /** Active model id surfaced to `prompt(...)`. */
  modelId: string | null;
  /** Latest known auth state. */
  status: ConnectionStatus;
  /** Latest persisted token bundle, kept in memory to avoid a re-read on
   *  every refresh. */
  tokens: TokenBundle | null;
  /** Composed MCP servers passed to `session/new` / `session/load`. */
  composedMcpServers: McpServerHttp[];
}

export interface CreateAppContextOptions {
  cwd: string;
  settings: SettingsStore;
  host: EmbeddedHost;
  renderer: Renderer;
  opener: BrowserOpener;
  initialSettings: Settings;
}

export function createAppContext(opts: CreateAppContextOptions): AppContext {
  const status: ConnectionStatus = opts.initialSettings.host
    ? { kind: 'disconnected', reason: 'token refresh pending' }
    : { kind: 'disconnected', reason: 'no host configured' };

  return {
    settings: opts.settings,
    host: opts.host,
    client: opts.host.client,
    renderer: opts.renderer,
    opener: opts.opener,
    cwd: opts.cwd,
    sessionId: null,
    modelId: opts.initialSettings.lastModelId ?? null,
    status,
    tokens: opts.initialSettings.tokens ?? null,
    composedMcpServers: [],
  };
}

export function setStatus(ctx: AppContext, status: ConnectionStatus): void {
  ctx.status = status;
  ctx.renderer.setStatus(status);
}
