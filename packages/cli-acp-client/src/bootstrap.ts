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
import { defaultBrowserOpener, type BrowserOpener } from './auth/browser-opener';
import { refreshTokens } from './auth/token-exchange';
import { DEFAULT_AUTH_SERVER_URL } from './auth/config';
import {
  buildDefaultRegistry,
  createQuitController,
  handlePrompt,
  type QuitController,
} from './commands';
import { CommandRegistry, createAppContext, createDispatcher, setStatus } from './shell';
import type { AppContext, Renderer } from './shell';
import { createLineRepl } from './tui/line-repl';
import { createPiRenderer } from './tui/pi-renderer';
import { createSettingsStore, type SettingsStore } from './settings/store';
import type { Settings } from './settings/schema';

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

  const quitController: QuitController = createQuitController(() => undefined);
  const registry = buildDefaultRegistry({ quitController });

  let runtimeStop: (() => void) | undefined;
  let renderer!: Renderer;
  let exited!: Promise<void>;
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

  const mode = opts.renderer ?? 'line';
  if (mode === 'pi-tui') {
    const tui = createPiRenderer({
      banner: opts.banner,
      slashCommands: registry.summaries(),
      basePath: opts.cwd,
      onSubmit: submit,
    });
    renderer = tui.renderer;
    exited = tui.exited;
    runtimeStop = tui.stop;
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

  const ctx = createAppContext({
    cwd: opts.cwd,
    settings: settingsStore,
    host,
    renderer,
    opener,
    initialSettings: initial,
  });
  renderer.setStatus(ctx.status);

  dispatcherHolder.current = createDispatcher(ctx, registry, line => handlePrompt(ctx, line));

  await tryRefreshTokens(ctx, initial);

  return {
    ctx,
    registry,
    exited,
    async shutdown(): Promise<void> {
      runtimeStop?.();
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
  setStatus(ctx, {
    kind: 'authenticated',
    host,
    modelId: ctx.modelId ?? undefined,
  });
}
