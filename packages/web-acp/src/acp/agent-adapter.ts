import type {
  Agent,
  AgentSideConnection,
  AuthenticateRequest,
  AuthenticateResponse,
  CancelNotification,
  InitializeRequest,
  InitializeResponse,
  LoadSessionRequest,
  LoadSessionResponse,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  SessionNotification,
} from '@agentclientprotocol/sdk';
import type { AgentMessage } from '@mariozechner/pi-agent-core';
import { BODHI_AUTH_METHOD_ID, type BodhiAuthenticateMeta } from './index';
import { extractSessionMeta, filterHttpServers } from './wire-utils';
import { dispatchExtMethod } from './engine/ext-methods';
import { PromptTurnDriver } from './engine/prompt-driver';
import type { AcpAdapterServices } from './engine/services';
import { AcpSessionRuntime } from './engine/session-runtime';
import type { ExtMethodHost } from './engine/types';

/**
 * Constants pulled in via Vite's `define`. Declared in `src/vite-env.d.ts`.
 * `typeof` guards keep this file buildable outside the Vite toolchain
 * (e.g. Vitest's transform path picks up `define`, but TypeScript
 * language servers running without the plugin don't).
 */
const IS_DEV = typeof __WEB_ACP_DEV__ === 'boolean' ? __WEB_ACP_DEV__ : false;
const BUILD_VERSION = typeof __WEB_ACP_VERSION__ === 'string' ? __WEB_ACP_VERSION__ : 'unknown';
const ACP_SDK_VERSION = typeof __ACP_SDK_VERSION__ === 'string' ? __ACP_SDK_VERSION__ : 'unknown';

/**
 * ACP wire shim. Implements the `Agent` interface and dispatches into
 * the engine layer:
 *
 *   - `AcpSessionRuntime` — session lifecycle + per-session state
 *   - `PromptTurnDriver` — single prompt-turn loop
 *   - `dispatchExtMethod` — `_bodhi/*` extension handlers
 *
 * Holds NO business logic of its own. Mirrors coding-agent's
 * `modes/rpc/rpc-mode.ts` posture: a thin dispatch shim. The
 * builtin-handler still lives inside `PromptTurnDriver` for now —
 * commit 6 of the engine refactor lifts it to its own file.
 */
export class AcpAgentAdapter implements Agent {
  readonly #services: AcpAdapterServices;
  readonly #runtime: AcpSessionRuntime;
  readonly #driver: PromptTurnDriver;

  constructor(conn: AgentSideConnection, services: AcpAdapterServices) {
    this.#services = services;
    this.#runtime = new AcpSessionRuntime(conn, services);
    this.#driver = new PromptTurnDriver({
      conn,
      services,
      runtime: this.#runtime,
      buildVersion: BUILD_VERSION,
      acpSdkVersion: ACP_SDK_VERSION,
      isDev: IS_DEV,
    });
  }

  async initialize(_params: InitializeRequest): Promise<InitializeResponse> {
    return {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: this.#services.store !== undefined,
        mcpCapabilities: {
          http: true,
          sse: false,
        },
        promptCapabilities: {
          image: false,
          audio: false,
          embeddedContext: false,
        },
      },
      authMethods: [
        {
          id: BODHI_AUTH_METHOD_ID,
          name: 'Bodhi token',
          description: 'Push a Bodhi access token from the main thread.',
        },
      ],
    };
  }

  async authenticate(params: AuthenticateRequest): Promise<AuthenticateResponse> {
    if (params.methodId !== BODHI_AUTH_METHOD_ID) {
      throw new Error(`Unsupported auth method: ${params.methodId}`);
    }
    const meta = (params._meta ?? {}) as Partial<BodhiAuthenticateMeta>;
    if (!meta.token || !meta.baseUrl) {
      throw new Error('authenticate: _meta must include { token, baseUrl }');
    }
    this.#services.bodhi.setAuthToken({
      provider: 'bodhi',
      token: meta.token,
      baseUrl: meta.baseUrl,
    });
    // Reset cached catalog so next listModels re-fetches under the new token.
    this.#runtime.setModels([]);
    this.#services.inline.clearMessages();
    return {};
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    const sessionId = `bodhi-${crypto.randomUUID()}`;
    const mcpServers = filterHttpServers(params.mcpServers ?? []);
    const sessionMeta = extractSessionMeta(params._meta);
    this.#runtime.setSession(sessionId, {
      id: sessionId,
      mcpServers,
      requestedMcpUrls: sessionMeta.requestedMcpUrls ?? [],
      mcpInstances: sessionMeta.mcpInstances ?? [],
    });
    if (this.#services.store) {
      await this.#services.store.createSession(sessionId);
    }
    this.#services.inline.clearMessages();
    this.#runtime.setActiveInlineSessionId(sessionId);
    await this.#runtime.acquireMcpConnections(sessionId, mcpServers);
    await this.#runtime.refreshAvailableCommands(sessionId);
    return { sessionId };
  }

  /**
   * Replay a persisted session:
   *   1. ensure the session exists in the store,
   *   2. re-emit every stored `SessionNotification` verbatim so the
   *      client's transcript state matches what it would have had if
   *      it had been watching live,
   *   3. reseed the inline agent's message history from the last
   *      stored `turn` so follow-up prompts use the restored context.
   *
   * The main thread learns the last used model by calling
   * `bodhi/listSessions` (or `getSession`); ACP's stable
   * `LoadSessionResponse` has no first-class place for that yet.
   */
  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    const store = this.#services.store;
    if (!store) {
      throw new Error('session/load: server has no session store configured');
    }
    const row = await store.getSession(params.sessionId);
    if (!row) {
      throw new Error(`session/load: unknown session '${params.sessionId}'`);
    }
    const mcpServers = filterHttpServers(params.mcpServers ?? []);
    const sessionMeta = extractSessionMeta(params._meta);
    const existing = this.#runtime.getSession(params.sessionId);
    if (existing) {
      // Releasing via a full `releaseAll` would also drop servers the
      // caller wants to keep; instead release exactly the configs the
      // session was previously holding so the pool can re-evaluate
      // refcounts and re-key under the new headers.
      await this.#runtime.releaseMcpConnections(params.sessionId, existing.mcpServers);
    }
    this.#runtime.setSession(params.sessionId, {
      id: params.sessionId,
      mcpServers,
      requestedMcpUrls: sessionMeta.requestedMcpUrls ?? [],
      mcpInstances: sessionMeta.mcpInstances ?? [],
    });

    const entries = await store.readEntries(params.sessionId);
    let lastTurnMessages: AgentMessage[] | undefined;
    for (const entry of entries) {
      if (entry.kind === 'notification') {
        // Re-emit verbatim via the raw connection. Replay must not
        // double-persist: the store already has this row.
        await this.#runtime.sendRawNotification(entry.payload as SessionNotification);
      } else if (entry.kind === 'turn') {
        const payload = entry.payload as { finalMessages?: AgentMessage[] };
        if (Array.isArray(payload.finalMessages)) {
          lastTurnMessages = payload.finalMessages;
        }
      }
    }
    if (lastTurnMessages) {
      this.#services.inline.restoreMessages(lastTurnMessages);
    } else {
      this.#services.inline.clearMessages();
    }
    this.#runtime.setActiveInlineSessionId(params.sessionId);
    await this.#runtime.acquireMcpConnections(params.sessionId, mcpServers);
    await this.#runtime.refreshAvailableCommands(params.sessionId);
    return {};
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    return this.#driver.run(params);
  }

  async cancel(_params: CancelNotification): Promise<void> {
    this.#driver.abort();
  }

  async extMethod(
    method: string,
    params: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    return dispatchExtMethod(method, params, this.#extMethodHost());
  }

  /**
   * Build the narrow facade ext-method handlers see. Bridges
   * adapter / runtime accessors so the per-handler files in
   * `engine/ext-methods/` stay independent of the adapter class.
   */
  #extMethodHost(): ExtMethodHost {
    const runtime = this.#runtime;
    return {
      bodhi: this.#services.bodhi,
      store: this.#services.store,
      registry: this.#services.registry,
      features: this.#services.features,
      mcpToggles: this.#services.mcpToggles,
      mcpPool: this.#services.mcpPool,
      inline: this.#services.inline,
      sessions: runtime.sessions,
      isDev: IS_DEV,
      getModels: () => runtime.getModels(),
      setModels: m => runtime.setModels(m),
      getActiveInlineSessionId: () => runtime.getActiveInlineSessionId(),
      setActiveInlineSessionId: id => runtime.setActiveInlineSessionId(id),
      readFeatures: sessionId => runtime.readFeatures(sessionId),
      readMcpToggles: sessionId => runtime.readMcpToggles(sessionId),
    };
  }

  /**
   * Release every MCP connection the adapter holds and clean up the
   * pool subscription. Worker teardown calls this via the
   * `AgentSideConnection` disconnect path.
   */
  async dispose(): Promise<void> {
    await this.#runtime.dispose();
  }
}
