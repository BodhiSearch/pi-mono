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
import type { StreamController } from '../acp/stream-controller';
import type { BrowserOpener } from '../auth/browser-opener';
import type { McpInstanceView } from '../mcp/bodhi-client';
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
   * Long-lived stream controller. Subscribed at boot; routes every
   * session/update through the streamingReducer state machine.
   */
  readonly stream: StreamController;
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
  /** Latest MCP instance catalog from BodhiApp, refreshed on auth events. */
  mcpInstances: McpInstanceView[];
  /** User-curated list of MCP URLs to request from BodhiApp on /login. */
  requestedMcps: string[];
  /**
   * DEV mode flag. Mirrors the agent's `isDev`. Surfaced so commands
   * like `/feature` can hint when a flag (e.g. `forceToolCall`) is
   * exposed but inert outside DEV builds.
   */
  readonly isDev: boolean;
}

export interface CreateAppContextOptions {
  cwd: string;
  settings: SettingsStore;
  host: EmbeddedHost;
  renderer: Renderer;
  opener: BrowserOpener;
  initialSettings: Settings;
  stream: StreamController;
  /** Resolved at boot time from `CLI_ACP_DEV` env var. */
  isDev: boolean;
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
    stream: opts.stream,
    sessionId: null,
    modelId: opts.initialSettings.lastModelId ?? null,
    status,
    tokens: opts.initialSettings.tokens ?? null,
    composedMcpServers: [],
    mcpInstances: [],
    requestedMcps: [],
    isDev: opts.isDev,
  };
}

export function setStatus(ctx: AppContext, status: ConnectionStatus): void {
  ctx.status = status;
  ctx.renderer.setStatus(status);
}
