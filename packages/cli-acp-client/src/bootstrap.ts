/**
 * Glue between the CLI entry point and the shell layer.
 *
 * `bootstrapCli` wires together: the embedded ACP host, the renderer
 * (pi-tui or line-mode), the dispatcher, and the slash command
 * registry. Returns a runtime object the caller awaits and tears down.
 *
 * Tests import this module directly to spin up an in-process CLI with
 * fake renderers, fake browser openers, and an ephemeral cwd.
 */

import { createEmbeddedHost, type EmbeddedHostOptions } from './acp/embedded-host';
import { createBuiltinActionDispatcher } from './acp/builtin-dispatch';
import { StreamController } from './acp/stream-controller';
import { defaultBrowserOpener, type BrowserOpener } from './auth/browser-opener';
import { refreshTokens } from './auth/token-exchange';
import { DEFAULT_AUTH_SERVER_URL } from './auth/config';
import {
  buildDefaultRegistry,
  createQuitController,
  handlePrompt,
  type QuitController,
} from './commands';
import { refreshMcpCatalog } from './mcp/catalog';
import { CommandRegistry, createAppContext, createDispatcher, setStatus } from './shell';
import type { AppContext, Renderer } from './shell';
import { createLineRepl } from './tui/line-repl';
import { createPiRenderer } from './tui/pi-renderer';
import { renderRichToolCall } from './tui/render-tool-call';
import { createSettingsStore, type SettingsStore } from './settings/store';
import type { Settings } from './settings/schema';
import { KV_LAST_MODEL_ID, KV_REQUESTED_MCPS } from './storage/kv-keys';
import type { KvStore } from './storage/sqlite-stores';

export type RendererMode = 'pi-tui' | 'line';

export interface BootstrapOptions {
  cwd: string;
  renderer?: RendererMode;
  opener?: BrowserOpener;
  banner?: string;
  /** Override the embedded host options (tests inject extra volumes). */
  hostOptions?: Partial<EmbeddedHostOptions>;
  /** Pre-built settings store — for tests using a tmpdir. */
  settingsStore?: SettingsStore;
  /** Override stdin/stdout when in `line` mode. */
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

export interface CliRuntime {
  ctx: AppContext;
  registry: CommandRegistry;
  /** Resolves when the user runs `/quit` or closes the input stream. */
  exited: Promise<void>;
  /** Tear down the embedded host and renderer. */
  shutdown(): Promise<void>;
}

export async function bootstrapCli(opts: BootstrapOptions): Promise<CliRuntime> {
  const settingsStore = opts.settingsStore ?? createSettingsStore(opts.cwd);
  const initial = await settingsStore.load();
  const opener = opts.opener ?? defaultBrowserOpener;

  const host = await createEmbeddedHost({
    cwd: opts.cwd,
    ...opts.hostOptions,
  });

  // One-shot migration: copy `requestedMcps` and `lastModelId` from
  // settings.json into sqlite kv. After this runs the kv table is
  // the source of truth; settings.json fields stay readable for
  // back-compat but are not written to.
  migrateSettingsIntoKv(host.kv, initial);

  const quitController: QuitController = createQuitController(() => undefined);
  const registry = buildDefaultRegistry({ quitController });

  let runtimeStop: (() => void) | undefined;
  let renderer!: Renderer;
  let exited!: Promise<void>;
  let setSlashCommands: ((commands: ReturnType<CommandRegistry['summaries']>) => void) | undefined;
  // `dispatcher` is created after the renderer + ctx; the editor's
  // submit handler is wired through this holder so the renderers can
  // be constructed first (they need `slashCommands` from the registry,
  // which is built before the dispatcher).
  const dispatcherHolder: { current?: ReturnType<typeof createDispatcher> } = {};

  const submit = async (line: string): Promise<void> => {
    const dispatcher = dispatcherHolder.current;
    if (!dispatcher) return;
    await dispatcher.submit(line);
    if (quitController.requested()) {
      runtimeStop?.();
    }
  };

  // Forward declaration: the cancel handler needs `ctxHolder` and
  // `streamHolder` (constructed below). We capture by closure so the
  // renderer can be built first.
  const ctxHolder: { current?: AppContext } = {};
  const streamHolder: { current?: StreamController } = {};
  const onCancelTurn = (): boolean => {
    const stream = streamHolder.current;
    const ctx = ctxHolder.current;
    if (!stream || !ctx) return false;
    if (!stream.getState().isStreaming) return false;
    if (!ctx.sessionId) return false;
    void ctx.client.cancel(ctx.sessionId).catch(err => {
      ctx.renderer.emit({
        kind: 'error',
        text: `cancel failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    });
    stream.dispatch({ type: 'reset' });
    ctx.renderer.emit({
      kind: 'system',
      text: '[cancelled] turn cancelled by user',
    });
    return true;
  };

  const mode = opts.renderer ?? 'line';
  if (mode === 'pi-tui') {
    const tui = createPiRenderer({
      banner: opts.banner,
      slashCommands: registry.summaries(),
      basePath: opts.cwd,
      onSubmit: submit,
      onCancelTurn,
    });
    renderer = tui.renderer;
    exited = tui.exited;
    runtimeStop = tui.stop;
    setSlashCommands = tui.setSlashCommands;
  } else {
    const repl = createLineRepl({
      banner: opts.banner,
      slashCommands: registry.summaries(),
      onSubmit: submit,
      input: opts.input,
      output: opts.output,
    });
    renderer = repl.renderer;
    exited = repl.exited;
    runtimeStop = repl.stop;
  }

  const stream = new StreamController({
    client: host.client,
    renderer,
    getSessionId: () => ctxHolder.current?.sessionId ?? null,
    dispatchBuiltinAction: async input => {
      const ctxNow = ctxHolder.current;
      if (!ctxNow) return;
      const dispatch = createBuiltinActionDispatcher(ctxNow);
      await dispatch(input);
    },
    // Only the pi-tui mode benefits from multi-line tool blocks; the
    // line-mode REPL is one-line-per-message by contract for
    // deterministic snapshot tests.
    renderToolCall: mode === 'pi-tui' ? renderRichToolCall : undefined,
  });
  streamHolder.current = stream;
  stream.start();

  // Forward agent-advertised commands into the editor's autocomplete
  // provider. The aggregated MCP status (e.g. "2/3 MCPs connected")
  // surfaces via `/mcp list` and per-server system lines emitted by
  // the StreamController; we deliberately keep the status bar
  // narrow (auth + model only).
  const baseSummaries = registry.summaries();
  let lastAdvertisedNames = '';
  stream.onStateChange(state => {
    if (!setSlashCommands) return;
    const advertisedNames = state.availableCommands.map(c => c.name).join(',');
    if (advertisedNames === lastAdvertisedNames) return;
    lastAdvertisedNames = advertisedNames;
    const merged = mergeCommandSummaries(baseSummaries, state.availableCommands);
    setSlashCommands(merged);
  });

  // Emit an aggregated "n/m MCPs connected" line each time any
  // server transitions between connected/disconnected, so users see
  // a one-shot summary alongside the per-server detail.
  let lastConnectedKey = '';
  stream.onStateChange(state => {
    const states = Object.values(state.mcpStates);
    if (states.length === 0) return;
    const connected = states.filter(s => s.state === 'connected').length;
    const key = `${connected}/${states.length}`;
    if (key === lastConnectedKey) return;
    lastConnectedKey = key;
    renderer.emit({
      kind: 'system',
      id: 'mcp:summary',
      text: `[mcp] ${connected}/${states.length} server(s) connected`,
    });
  });

  const ctx = createAppContext({
    cwd: opts.cwd,
    settings: settingsStore,
    host,
    renderer,
    opener,
    initialSettings: initial,
    stream,
    isDev: opts.hostOptions?.isDev ?? false,
  });
  ctxHolder.current = ctx;
  // Hydrate runtime state from kv (post-migration source of truth).
  ctx.requestedMcps = host.kv.get<string[]>(KV_REQUESTED_MCPS) ?? [];
  const persistedModelId = host.kv.get<string>(KV_LAST_MODEL_ID);
  if (persistedModelId && !ctx.modelId) ctx.modelId = persistedModelId;
  renderer.setStatus(ctx.status);

  dispatcherHolder.current = createDispatcher(ctx, registry, line => handlePrompt(ctx, line));

  await tryRefreshTokens(ctx, initial);

  return {
    ctx,
    registry,
    exited,
    async shutdown(): Promise<void> {
      runtimeStop?.();
      stream.stop();
      try {
        await host.dispose();
      } catch (err) {
        console.error('[cli] host.dispose() failed:', err);
      }
    },
  };
}

/**
 * If we have a stored refresh token AND the access token is expired,
 * silently refresh and re-authenticate the embedded agent. Failures
 * downgrade to a `/login` prompt rather than aborting startup.
 */
async function tryRefreshTokens(ctx: AppContext, initial: Settings): Promise<void> {
  if (!initial.host || !initial.tokens) return;
  const now = Date.now();
  if (initial.tokens.expiresAt - 30_000 > now) {
    // Still fresh enough; just re-authenticate the agent.
    await pushTokenToAgent(ctx, initial.host, initial.tokens.accessToken);
    return;
  }
  if (!initial.tokens.refreshToken) {
    setStatus(ctx, { kind: 'disconnected', reason: 'access token expired; run /login' });
    return;
  }
  try {
    const fresh = await refreshTokens({
      authServerUrl: initial.authServerUrl ?? DEFAULT_AUTH_SERVER_URL,
      refreshToken: initial.tokens.refreshToken,
    });
    ctx.tokens = fresh;
    await ctx.settings.patch({ tokens: fresh });
    await pushTokenToAgent(ctx, initial.host, fresh.accessToken);
  } catch (err) {
    setStatus(ctx, {
      kind: 'disconnected',
      reason: `refresh failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

/**
 * Merge the static CLI-shell command summaries with the agent's
 * dynamic `available_commands_update` payload. CLI-shell commands
 * win on name collision so users keep the local semantics for
 * `/help`, `/quit`, `/host`, etc.
 */
function mergeCommandSummaries(
  baseSummaries: ReturnType<CommandRegistry['summaries']>,
  advertised: { name: string; description: string }[]
): ReturnType<CommandRegistry['summaries']> {
  const seen = new Set(baseSummaries.map(s => s.name));
  const merged = [...baseSummaries];
  for (const cmd of advertised) {
    if (seen.has(cmd.name)) continue;
    seen.add(cmd.name);
    merged.push({ name: cmd.name, description: cmd.description });
  }
  return merged;
}

async function pushTokenToAgent(ctx: AppContext, host: string, token: string): Promise<void> {
  setStatus(ctx, { kind: 'authenticating', host });
  await ctx.client.authenticate({ token, baseUrl: host });
  // The agent's prompt-driver resolves `_meta.bodhi.modelId` against an
  // in-memory model catalog populated only by `bodhi/listModels`. On a
  // fresh process restart the catalog is empty, so even though we
  // restored `ctx.modelId` from settings, the very next prompt would
  // fail with "No model selected" until the user manually ran
  // `/models`. Warm the catalog here so restored state is immediately
  // usable. A failure is non-fatal — the user can still run /models.
  try {
    await ctx.client.listModels();
  } catch (err) {
    ctx.renderer.emit({
      kind: 'system',
      text: `warm-up listModels failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  // Refresh the MCP catalog under the new token; if a session is
  // already in flight we re-issue session/load so the worker pool
  // picks up the rotated `Authorization: Bearer` header per
  // `packages/web-acp/src/hooks/useAcpAuth.ts:112-135`.
  try {
    await refreshMcpCatalog(ctx);
    if (ctx.sessionId && !ctx.stream.getState().isStreaming) {
      const meta =
        ctx.requestedMcps.length > 0 || ctx.mcpInstances.length > 0
          ? {
              requestedMcpUrls: [...ctx.requestedMcps],
              mcpInstances: ctx.mcpInstances.map(i => ({
                slug: i.slug,
                name: i.name,
                path: i.path,
              })),
            }
          : undefined;
      await ctx.client.loadSession(ctx.sessionId, ctx.cwd, ctx.composedMcpServers, meta);
    }
  } catch (err) {
    ctx.renderer.emit({
      kind: 'system',
      text: `MCP refresh after token push failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  setStatus(ctx, {
    kind: 'authenticated',
    host,
    modelId: ctx.modelId ?? undefined,
  });
}

function migrateSettingsIntoKv(kv: KvStore, settings: Settings): void {
  if (!kv.get(KV_REQUESTED_MCPS) && settings.requestedMcps && settings.requestedMcps.length > 0) {
    kv.set(KV_REQUESTED_MCPS, settings.requestedMcps);
  }
  if (!kv.get(KV_LAST_MODEL_ID) && settings.lastModelId) {
    kv.set(KV_LAST_MODEL_ID, settings.lastModelId);
  }
}
