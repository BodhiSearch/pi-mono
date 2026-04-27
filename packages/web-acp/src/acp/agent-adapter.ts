import type {
  Agent,
  AgentSideConnection,
  AuthenticateRequest,
  AuthenticateResponse,
  AvailableCommand,
  CancelNotification,
  InitializeRequest,
  InitializeResponse,
  LoadSessionRequest,
  LoadSessionResponse,
  McpServer,
  McpServerHttp,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  SessionNotification,
  ToolCall as AcpToolCall,
  ToolCallStatus,
  ToolCallUpdate as AcpToolCallUpdate,
} from '@agentclientprotocol/sdk';
import type {
  AgentEvent,
  AgentMessage,
  AgentMessage as CoreMessage,
  AgentTool,
  AgentToolResult,
  AgentToolUpdateCallback,
} from '@mariozechner/pi-agent-core';
import type { TSchema } from '@sinclair/typebox';
import type { Api, Model } from '@mariozechner/pi-ai';
import type { BodhiProvider } from '@/agent/bodhi-provider';
import { apiFormatOfModel } from '@/agent/bodhi-provider';
import {
  createZenfsCommandsFs,
  expandCommand,
  loadCommandsFromVolumes,
  type CommandDef,
  type CommandsFs,
} from '@/agent/commands';
import {
  builtinAvailableCommands,
  findBuiltin,
  type BuiltinHandlerCtx,
} from '@/agent/commands/builtins';
import type { InlineAgent } from '@/agent/inline-agent';
import {
  createMcpAgentTool,
  McpConnectionPool,
  type McpPoolEvent,
  type McpToolDetails,
} from '@/agent/mcp';
import type { BuiltinPayload, SessionStore, TurnPayload } from '@/agent/session-store';
import type { StreamOptionOverrides } from '@/agent/stream-fn';
import { composeSystemPrompt } from '@/agent/system-prompt';
import { createBashTool } from '@/agent/tools/bash-tool';
import type { VolumeRegistry } from '@/agent/volume-mount';
import type { FeatureSnapshot, FeatureStore } from '@/features/feature-store';
import { FEATURE_DEFAULTS, isFeatureKey } from '@/features/feature-store';
import type { McpToggleSnapshot, McpToggleStore } from '@/mcp/toggle-store';
import { isToolEnabled } from '@/mcp/toggle-store';
import {
  BODHI_AUTH_METHOD_ID,
  BODHI_FEATURES_LIST_METHOD,
  BODHI_FEATURES_SET_METHOD,
  BODHI_GET_SESSION_METHOD,
  BODHI_LIST_MODELS_METHOD,
  BODHI_LIST_SESSIONS_METHOD,
  BODHI_MCP_TOGGLES_SET_METHOD,
  BODHI_SESSIONS_DELETE_METHOD,
  BODHI_VOLUMES_LIST_METHOD,
  type BodhiAuthenticateMeta,
  type BodhiFeaturesListResponse,
  type BodhiFeaturesSetRequest,
  type BodhiFeaturesSetResponse,
  type BodhiGetSessionRequest,
  type BodhiGetSessionResponse,
  type BodhiListModelsResponse,
  type BodhiListSessionsResponse,
  type BodhiMcpToggleSnapshot,
  type BodhiMcpTogglesSetRequest,
  type BodhiMcpTogglesSetResponse,
  type BodhiSessionsDeleteRequest,
  type BodhiSessionsDeleteResponse,
  type BodhiVolumesListResponse,
} from './index';

interface SessionState {
  id: string;
  /** MCP server configs this session acquired on `session/new` or `session/load`. */
  mcpServers: McpServerHttp[];
}

interface BodhiPromptMeta {
  bodhi?: {
    modelId?: string;
  };
}

interface StreamCursor {
  messageId: string | undefined;
  emittedLength: number;
}

interface StreamOverridesRef {
  current: StreamOptionOverrides;
}

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
 * ACP agent handler that bridges the inline pi-agent-core runtime to the
 * protocol. Translates pi-agent-core `AgentEvent`s into `session/update`
 * notifications and returns a `StopReason` for each `session/prompt`
 * request.
 */
export class AcpAgentAdapter implements Agent {
  readonly #conn: AgentSideConnection;
  readonly #inline: InlineAgent;
  readonly #bodhi: BodhiProvider;
  readonly #store: SessionStore | undefined;
  readonly #registry: VolumeRegistry | undefined;
  readonly #features: FeatureStore | undefined;
  readonly #mcpToggles: McpToggleStore | undefined;
  readonly #streamOverrides: StreamOverridesRef | undefined;
  readonly #mcpPool: McpConnectionPool;
  readonly #mcpSubscription: () => void;
  readonly #commandsFs: CommandsFs;
  readonly #sessions = new Map<string, SessionState>();
  #availableCommands: CommandDef[] = [];
  #models: Model<Api>[] = [];
  #cancelled = false;
  /**
   * Per-turn abort controller. M2 phase B wires `session/cancel` into
   * this so long-running `bash` executions can be interrupted by the
   * ACP cancel notification without waiting for the LLM stream to
   * settle on its own.
   */
  #turnAbort: AbortController | undefined;
  /**
   * The `InlineAgent` holds a single `pi-agent-core` runtime that carries
   * one message history at a time. We must remember which session's
   * history is currently loaded into it so that `prompt` calls coming
   * in for a different session don't accidentally splice contexts
   * together (which would poison the next `recordTurn`'s
   * `finalMessages`).
   */
  #activeInlineSessionId: string | null = null;

  constructor(
    conn: AgentSideConnection,
    inline: InlineAgent,
    bodhi: BodhiProvider,
    store?: SessionStore,
    registry?: VolumeRegistry,
    features?: FeatureStore,
    streamOverrides?: StreamOverridesRef,
    mcpPool?: McpConnectionPool,
    mcpToggles?: McpToggleStore,
    commandsFs?: CommandsFs
  ) {
    this.#conn = conn;
    this.#inline = inline;
    this.#bodhi = bodhi;
    this.#store = store;
    this.#registry = registry;
    this.#features = features;
    this.#mcpToggles = mcpToggles;
    this.#streamOverrides = streamOverrides;
    this.#mcpPool = mcpPool ?? new McpConnectionPool();
    this.#mcpSubscription = this.#mcpPool.subscribe(event => {
      void this.#broadcastMcpPoolEvent(event);
    });
    this.#commandsFs = commandsFs ?? createZenfsCommandsFs();
  }

  async initialize(_params: InitializeRequest): Promise<InitializeResponse> {
    return {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: this.#store !== undefined,
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
    this.#bodhi.setAuthToken({ provider: 'bodhi', token: meta.token, baseUrl: meta.baseUrl });
    // Reset cached catalog so next listModels re-fetches under the new token.
    this.#models = [];
    this.#inline.clearMessages();
    return {};
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    const sessionId = `bodhi-${crypto.randomUUID()}`;
    const mcpServers = filterHttpServers(params.mcpServers ?? []);
    this.#sessions.set(sessionId, { id: sessionId, mcpServers });
    if (this.#store) {
      await this.#store.createSession(sessionId);
    }
    this.#inline.clearMessages();
    this.#activeInlineSessionId = sessionId;
    await this.#acquireMcpConnections(sessionId, mcpServers);
    await this.#refreshAvailableCommands(sessionId);
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
    if (!this.#store) {
      throw new Error('session/load: server has no session store configured');
    }
    const row = await this.#store.getSession(params.sessionId);
    if (!row) {
      throw new Error(`session/load: unknown session '${params.sessionId}'`);
    }
    const mcpServers = filterHttpServers(params.mcpServers ?? []);
    const existing = this.#sessions.get(params.sessionId);
    if (existing) {
      // Releasing via a full `releaseAll` would also drop servers the
      // caller wants to keep; instead release exactly the configs the
      // session was previously holding so the pool can re-evaluate
      // refcounts and re-key under the new headers.
      await Promise.all(
        existing.mcpServers.map(cfg => this.#mcpPool.release(params.sessionId, cfg))
      );
    }
    this.#sessions.set(params.sessionId, { id: params.sessionId, mcpServers });

    const entries = await this.#store.readEntries(params.sessionId);
    let lastTurnMessages: AgentMessage[] | undefined;
    for (const entry of entries) {
      if (entry.kind === 'notification') {
        // Re-emit verbatim via the raw connection. We deliberately do
        // NOT funnel through `#emit` because replay must not double-
        // persist: the store already has this row.
        await this.#conn.sessionUpdate(entry.payload as SessionNotification);
      } else if (entry.kind === 'turn') {
        const payload = entry.payload as { finalMessages?: AgentMessage[] };
        if (Array.isArray(payload.finalMessages)) {
          lastTurnMessages = payload.finalMessages;
        }
      }
    }
    if (lastTurnMessages) {
      this.#inline.restoreMessages(lastTurnMessages);
    } else {
      this.#inline.clearMessages();
    }
    this.#activeInlineSessionId = params.sessionId;
    await this.#acquireMcpConnections(params.sessionId, mcpServers);
    await this.#refreshAvailableCommands(params.sessionId);
    return {};
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const session = this.#sessions.get(params.sessionId);
    if (!session) {
      throw new Error(`Unknown session: ${params.sessionId}`);
    }

    // M4 phase B: built-in slash commands run before any model
    // resolution / expansion so `/help`, `/version`, etc. work even
    // when no model is selected and never count against the LLM
    // history. The handler decides everything; we emit a chunk +
    // persist a 'builtin' entry + return without touching the inline
    // agent.
    const rawText = this.#extractPromptText(params);
    if (rawText) {
      const handled = await this.#tryHandleBuiltin(params, rawText);
      if (handled) return handled;
    }

    const model = this.#resolveModel(params);
    if (!model) {
      throw new Error('No model selected: send session/prompt with _meta.bodhi.modelId');
    }

    this.#applySlashCommandExpansion(params);
    const text = this.#extractPromptText(params);
    if (!text) {
      throw new Error('session/prompt payload must contain at least one text block');
    }

    // Guard against prompt being routed to a session whose history is
    // not currently loaded into the inline runtime. This can happen
    // after the worker restarts and the client races a prompt before
    // issuing `session/load`. Rebuild state from the store so we
    // don't splice another session's context into this one.
    if (this.#activeInlineSessionId !== params.sessionId) {
      await this.#rehydrateInlineFromStore(params.sessionId);
    }

    const featureSnapshot = await this.#readFeatures(params.sessionId);
    const mcpToggleSnapshot = await this.#readMcpToggles(params.sessionId);
    const volumes = this.#registry?.list() ?? [];
    const tools: AgentTool<TSchema>[] = [];
    const hasVolumes = volumes.length > 0;
    this.#turnAbort = new AbortController();
    if (featureSnapshot.bashEnabled && hasVolumes && this.#registry) {
      const bashTool = createBashTool({ registry: this.#registry });
      tools.push(bindAbortSignal(bashTool, this.#turnAbort.signal) as AgentTool<TSchema>);
    }
    for (const mcpTool of this.#mcpToolsForSession(session, mcpToggleSnapshot)) {
      tools.push(bindAbortSignal(mcpTool, this.#turnAbort.signal) as AgentTool<TSchema>);
    }
    const systemPrompt = composeSystemPrompt(volumes);
    this.#inline.setModel(model, { tools, systemPrompt });

    // Push per-turn stream overrides. `forceToolCall` is gated to DEV
    // and only meaningful when we actually registered a tool.
    if (this.#streamOverrides) {
      const toolChoice =
        featureSnapshot.forceToolCall && IS_DEV && tools.length > 0 ? 'required' : undefined;
      this.#streamOverrides.current = toolChoice ? { toolChoice } : {};
    }

    const cursor: StreamCursor = { messageId: undefined, emittedLength: 0 };
    this.#cancelled = false;
    const toolState = new Map<string, { toolName: string; args: unknown }>();

    const unsubscribe = this.#inline.subscribe(event => {
      void this.#forwardEvent(params.sessionId, event, cursor, toolState);
    });

    try {
      await this.#inline.prompt(text);
      if (this.#cancelled) {
        return { stopReason: 'cancelled' };
      }
      const errorMessage = this.#inline.getErrorMessage();
      if (errorMessage) {
        throw new Error(errorMessage);
      }
      if (this.#store) {
        await this.#store.recordTurn(params.sessionId, text, this.#inline.getMessages(), model.id);
      }
      return { stopReason: 'end_turn' };
    } finally {
      unsubscribe();
      if (this.#streamOverrides) this.#streamOverrides.current = {};
      this.#turnAbort = undefined;
    }
  }

  async cancel(_params: CancelNotification): Promise<void> {
    this.#cancelled = true;
    this.#turnAbort?.abort();
    this.#inline.cancel();
  }

  async extMethod(
    method: string,
    _params: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    if (method === BODHI_LIST_MODELS_METHOD) {
      this.#models = await this.#bodhi.getAvailableModels();
      const response: BodhiListModelsResponse = {
        models: this.#models.map(m => ({ id: m.id, apiFormat: apiFormatOfModel(m) })),
      };
      return response;
    }
    if (method === BODHI_LIST_SESSIONS_METHOD) {
      const summaries = this.#store ? await this.#store.listSummaries() : [];
      const response: BodhiListSessionsResponse = { sessions: summaries };
      return response;
    }
    if (method === BODHI_VOLUMES_LIST_METHOD) {
      const volumes = this.#registry?.list() ?? [];
      const response: BodhiVolumesListResponse = {
        volumes: volumes.map(v => ({
          mountName: v.mountName,
          ...(v.description ? { description: v.description } : {}),
        })),
      };
      return response;
    }
    if (method === BODHI_FEATURES_LIST_METHOD) {
      const sessionId = (_params as { sessionId?: unknown }).sessionId;
      if (typeof sessionId !== 'string') {
        throw new Error(`${BODHI_FEATURES_LIST_METHOD}: params.sessionId is required`);
      }
      const features = await this.#readFeatures(sessionId);
      const response: BodhiFeaturesListResponse = {
        features: { ...features },
        defaults: { ...FEATURE_DEFAULTS },
      };
      return response;
    }
    if (method === BODHI_FEATURES_SET_METHOD) {
      const req = _params as BodhiFeaturesSetRequest;
      if (
        !req ||
        typeof req.sessionId !== 'string' ||
        typeof req.key !== 'string' ||
        typeof req.value !== 'boolean'
      ) {
        throw new Error(
          `${BODHI_FEATURES_SET_METHOD}: params must be { sessionId, key, value: boolean }`
        );
      }
      if (!isFeatureKey(req.key)) {
        throw new Error(`${BODHI_FEATURES_SET_METHOD}: unknown feature '${req.key}'`);
      }
      if (req.key === 'forceToolCall' && !IS_DEV) {
        const err = new Error('forceToolCall is DEV-only');
        (err as unknown as { code: number }).code = -32004;
        throw err;
      }
      if (!this.#features) {
        throw new Error(`${BODHI_FEATURES_SET_METHOD}: feature store unavailable`);
      }
      const next = await this.#features.set(req.sessionId, req.key, req.value);
      const response: BodhiFeaturesSetResponse = { features: { ...next } };
      return response;
    }
    if (method === BODHI_GET_SESSION_METHOD) {
      if (!this.#store) {
        throw new Error(`${BODHI_GET_SESSION_METHOD}: no session store configured`);
      }
      const req = _params as BodhiGetSessionRequest;
      if (!req || typeof req.sessionId !== 'string') {
        throw new Error(`${BODHI_GET_SESSION_METHOD}: params.sessionId is required`);
      }
      const row = await this.#store.getSession(req.sessionId);
      if (!row) {
        throw new Error(`${BODHI_GET_SESSION_METHOD}: unknown session '${req.sessionId}'`);
      }
      const entries = await this.#store.readEntries(req.sessionId);
      // Walk entries in seq order to build the rendered transcript:
      // - 'turn' entries carry the cumulative LLM-visible history;
      //   we append the delta from the previous turn's snapshot.
      // - 'builtin' entries are inserted as a tagged user+assistant
      //   pair so reload reproduces them in the right chronological
      //   slot. They never feed `inline.restoreMessages()` because
      //   that path consumes only 'turn' kinds.
      let lastTurnMessages: AgentMessage[] = [];
      const messages: unknown[] = [];
      for (const entry of entries) {
        if (entry.kind === 'turn') {
          const payload = entry.payload as TurnPayload;
          const next = Array.isArray(payload.finalMessages) ? payload.finalMessages : [];
          if (next.length > lastTurnMessages.length) {
            messages.push(...next.slice(lastTurnMessages.length));
          }
          lastTurnMessages = next;
        } else if (entry.kind === 'builtin') {
          const payload = entry.payload as BuiltinPayload;
          const tag = {
            command: payload.command,
            ...(payload.action ? { action: payload.action } : {}),
          };
          messages.push(makeBuiltinUserMessage(payload.userText, tag));
          messages.push(makeBuiltinAssistantMessage(payload.replyText, tag));
        }
      }
      const mcpToggles = await this.#readMcpToggles(req.sessionId);
      const response: BodhiGetSessionResponse = {
        sessionId: row.id,
        messages,
        lastModelId: row.lastModelId,
        title: row.title,
        mcpToggles: toWireMcpToggles(mcpToggles),
      };
      return response;
    }
    if (method === BODHI_MCP_TOGGLES_SET_METHOD) {
      if (!this.#mcpToggles) {
        throw new Error(`${BODHI_MCP_TOGGLES_SET_METHOD}: mcp toggle store unavailable`);
      }
      const req = _params as BodhiMcpTogglesSetRequest;
      if (
        !req ||
        typeof req.sessionId !== 'string' ||
        typeof req.serverSlug !== 'string' ||
        typeof req.value !== 'boolean'
      ) {
        throw new Error(
          `${BODHI_MCP_TOGGLES_SET_METHOD}: params must be { sessionId, serverSlug, toolName?, value: boolean }`
        );
      }
      const next = req.toolName
        ? await this.#mcpToggles.setTool(req.sessionId, req.serverSlug, req.toolName, req.value)
        : await this.#mcpToggles.setServer(req.sessionId, req.serverSlug, req.value);
      const response: BodhiMcpTogglesSetResponse = { toggles: toWireMcpToggles(next) };
      return response;
    }
    if (method === BODHI_SESSIONS_DELETE_METHOD) {
      if (!this.#store) {
        throw new Error(`${BODHI_SESSIONS_DELETE_METHOD}: no session store configured`);
      }
      const req = _params as BodhiSessionsDeleteRequest;
      if (!req || typeof req.sessionId !== 'string') {
        throw new Error(`${BODHI_SESSIONS_DELETE_METHOD}: params.sessionId is required`);
      }
      const row = await this.#store.getSession(req.sessionId);
      if (!row) {
        const response: BodhiSessionsDeleteResponse = { deleted: false };
        return response;
      }
      // Drop in-memory state before the row vanishes so a stray late
      // event for this session can't reattach to a phantom entry.
      await this.#mcpPool.releaseAll(req.sessionId);
      this.#sessions.delete(req.sessionId);
      if (this.#activeInlineSessionId === req.sessionId) {
        this.#activeInlineSessionId = null;
        this.#inline.clearMessages();
      }
      await this.#store.deleteSession(req.sessionId);
      const response: BodhiSessionsDeleteResponse = { deleted: true };
      return response;
    }
    throw new Error(`Unknown extension method: ${method}`);
  }

  /**
   * Acquire each MCP server for the given session. Errors from the
   * pool are swallowed here — the pool already emits `error` events
   * that travel through `#broadcastMcpPoolEvent`, and the session
   * itself should still be usable even if a single MCP server fails
   * to connect (the tool simply won't be registered).
   */
  async #acquireMcpConnections(sessionId: string, servers: McpServerHttp[]): Promise<void> {
    await Promise.all(
      servers.map(async cfg => {
        try {
          await this.#mcpPool.acquire(sessionId, cfg);
        } catch (err) {
          console.error(`[acp-agent-adapter] MCP acquire failed for ${cfg.name}:`, err);
        }
      })
    );
  }

  /**
   * Build the per-turn MCP tool list for the session by reading the
   * cached `tools/list` catalog from the pool and adapting every tool
   * into an `AgentTool`. Tools from servers that failed to connect
   * are silently omitted. Per-tool toggles filter further here
   * (server-level toggles are already applied upstream in
   * `composeMcpServers`, so the worker never sees those servers).
   */
  #mcpToolsForSession(
    session: SessionState,
    toggles: McpToggleSnapshot
  ): AgentTool<TSchema, McpToolDetails>[] {
    const out: AgentTool<TSchema, McpToolDetails>[] = [];
    for (const cfg of session.mcpServers) {
      const client = this.#mcpPool.getClient(cfg);
      if (!client) continue;
      const tools = this.#mcpPool.getTools(cfg);
      for (const tool of tools) {
        if (!isToolEnabled(toggles, cfg.name, tool.name)) continue;
        out.push(createMcpAgentTool({ client, serverName: cfg.name, tool }));
      }
    }
    return out;
  }

  async #readMcpToggles(sessionId: string): Promise<McpToggleSnapshot> {
    if (!this.#mcpToggles) return { servers: {}, tools: {} };
    try {
      return await this.#mcpToggles.get(sessionId);
    } catch (err) {
      console.error('[acp-agent-adapter] failed to load mcp toggles:', err);
      return { servers: {}, tools: {} };
    }
  }

  /**
   * Forward MCP pool lifecycle events to every known session as a
   * `session/update` notification carrying `_meta.bodhi.mcp`. ACP
   * doesn't define a first-class transport-level verb, so we ride on
   * an empty `agent_message_chunk` — the main thread's hook filters
   * by `_meta.bodhi.mcp` before touching the message stream.
   *
   * These events are **transient**: they describe the live state of
   * the worker's pool, which is rebuilt from scratch on every
   * `session/load`. We send them to the client directly but do NOT
   * persist them via `recordNotification`, because otherwise a
   * subsequent `loadSession` would replay stale `connecting` /
   * `connected` events after the pool has already emitted a fresh
   * `disconnected` (e.g. following a per-server toggle flip).
   */
  async #broadcastMcpPoolEvent(event: McpPoolEvent): Promise<void> {
    const affected = new Set<string>();
    for (const [sessionId, state] of this.#sessions) {
      if (state.mcpServers.some(cfg => cfg.name === event.server && cfg.url === event.url)) {
        affected.add(sessionId);
      }
    }
    if (affected.size === 0) return;
    const meta = {
      bodhi: {
        mcp: {
          server: event.server,
          state: poolEventToState(event.type),
          ...(event.error ? { error: event.error } : {}),
          ...(event.tools ? { tools: event.tools } : {}),
        },
      },
    };
    await Promise.all(
      [...affected].map(sessionId =>
        this.#conn.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: '' },
          },
          _meta: meta,
        } as SessionNotification)
      )
    );
  }

  /**
   * Release every MCP connection the adapter holds and clean up the
   * pool subscription. Worker teardown calls this via the
   * `AgentSideConnection` disconnect path.
   */
  async dispose(): Promise<void> {
    this.#mcpSubscription();
    const sessionIds = [...this.#sessions.keys()];
    await Promise.all(sessionIds.map(id => this.#mcpPool.releaseAll(id)));
    this.#sessions.clear();
  }

  async #readFeatures(sessionId: string): Promise<FeatureSnapshot> {
    if (!this.#features) {
      return { ...FEATURE_DEFAULTS };
    }
    try {
      return await this.#features.get(sessionId);
    } catch (err) {
      console.error('[acp-agent-adapter] failed to load features:', err);
      return { ...FEATURE_DEFAULTS };
    }
  }

  async #rehydrateInlineFromStore(sessionId: string): Promise<void> {
    if (!this.#store) {
      this.#inline.clearMessages();
      this.#activeInlineSessionId = sessionId;
      return;
    }
    const entries = await this.#store.readEntries(sessionId);
    let lastTurnMessages: AgentMessage[] | undefined;
    for (const entry of entries) {
      if (entry.kind === 'turn') {
        const payload = entry.payload as { finalMessages?: AgentMessage[] };
        if (Array.isArray(payload.finalMessages)) {
          lastTurnMessages = payload.finalMessages;
        }
      }
    }
    if (lastTurnMessages) {
      this.#inline.restoreMessages(lastTurnMessages);
    } else {
      this.#inline.clearMessages();
    }
    this.#activeInlineSessionId = sessionId;
  }

  #resolveModel(params: PromptRequest): Model<Api> | undefined {
    const meta = (params._meta ?? {}) as BodhiPromptMeta;
    const modelId = meta.bodhi?.modelId;
    if (!modelId) return undefined;
    return this.#models.find(m => m.id === modelId);
  }

  #extractPromptText(params: PromptRequest): string {
    const parts: string[] = [];
    for (const block of params.prompt ?? []) {
      if (block && block.type === 'text' && typeof block.text === 'string') {
        parts.push(block.text);
      }
    }
    return parts.join('');
  }

  async #forwardEvent(
    sessionId: string,
    event: AgentEvent,
    cursor: StreamCursor,
    toolState: Map<string, { toolName: string; args: unknown }>
  ): Promise<void> {
    if (event.type === 'message_update') {
      const msg = event.message;
      if (msg.role !== 'assistant') return;

      const messageId = extractMessageId(msg);
      if (messageId !== cursor.messageId) {
        cursor.messageId = messageId;
        cursor.emittedLength = 0;
      }

      const text = extractAssistantText(msg);
      if (text.length <= cursor.emittedLength) return;
      const delta = text.slice(cursor.emittedLength);
      cursor.emittedLength = text.length;

      await this.#emit({
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: delta },
          ...(messageId ? { messageId } : {}),
        },
      });
      return;
    }
    if (event.type === 'tool_execution_start') {
      toolState.set(event.toolCallId, { toolName: event.toolName, args: event.args });
      const payload: AcpToolCall = {
        toolCallId: event.toolCallId,
        title: toolTitle(event.toolName, event.args),
        kind: 'execute',
        status: 'in_progress',
        rawInput: event.args,
      };
      await this.#emit({
        sessionId,
        update: { sessionUpdate: 'tool_call', ...payload },
      });
      return;
    }
    if (event.type === 'tool_execution_update') {
      const update: AcpToolCallUpdate = {
        toolCallId: event.toolCallId,
        status: 'in_progress',
        ...(event.partialResult?.content
          ? {
              content: toToolCallContent(event.partialResult.content),
            }
          : {}),
      };
      await this.#emit({
        sessionId,
        update: { sessionUpdate: 'tool_call_update', ...update },
      });
      return;
    }
    if (event.type === 'tool_execution_end') {
      const status: ToolCallStatus = event.isError ? 'failed' : 'completed';
      const content = event.result?.content ? toToolCallContent(event.result.content) : undefined;
      const update: AcpToolCallUpdate = {
        toolCallId: event.toolCallId,
        status,
        rawOutput: event.result?.details ?? event.result,
        ...(content ? { content } : {}),
      };
      await this.#emit({
        sessionId,
        update: { sessionUpdate: 'tool_call_update', ...update },
      });
      toolState.delete(event.toolCallId);
      return;
    }
  }

  /**
   * Refresh the cached vault command list and emit the matching
   * `available_commands_update` notification for the given session.
   * Called once at the end of `newSession` and `loadSession`. The
   * cached `CommandDef[]` is shared across sessions because the vault
   * is per-worker, but each notification carries its own `sessionId`
   * so the persisted-replay path stays accurate.
   *
   * M4 phase B: agent-handled built-ins (`/help`, `/version`, …) ride
   * the same wire — merged into the advertised list so the picker
   * stays a black-box consumer of `AvailableCommand[]`.
   */
  async #refreshAvailableCommands(sessionId: string): Promise<void> {
    const mounts = this.#registry?.list() ?? [];
    let defs: CommandDef[] = [];
    if (mounts.length > 0) {
      try {
        defs = await loadCommandsFromVolumes({
          mounts,
          fs: this.#commandsFs,
        });
      } catch (err) {
        console.error('[acp-agent-adapter] command load failed:', err);
        defs = [];
      }
    }
    this.#availableCommands = defs;
    const availableCommands: AvailableCommand[] = [
      ...builtinAvailableCommands(),
      ...defs.map(toAvailableCommand),
    ];
    await this.#emit({
      sessionId,
      update: {
        sessionUpdate: 'available_commands_update',
        availableCommands,
      },
    });
  }

  /**
   * Recognise an agent-handled built-in (M4 phase B). Returns a
   * resolved `PromptResponse` when the input matched (the chunk + the
   * `'builtin'` store entry have already been written) and `null`
   * otherwise so the caller falls through to the normal LLM path.
   *
   * Built-ins emit via the raw connection (NOT `#emit`) so they don't
   * also get persisted as `'notification'` entries — the `'builtin'`
   * store entry plus the `bodhi/getSession` interleaving on reload is
   * the single source of truth for replay.
   */
  async #tryHandleBuiltin(params: PromptRequest, rawText: string): Promise<PromptResponse | null> {
    const match = findBuiltin(rawText);
    if (!match) return null;
    const sessionId = params.sessionId;
    const ctx: BuiltinHandlerCtx = {
      sessionId,
      modelId: this.#resolveBuiltinModelId(params),
      serverUrl: this.#bodhi.getBaseUrl?.() ?? null,
      sessionStats: await this.#sessionStatsFor(sessionId),
      mcpServersConnected: this.#mcpConnectedFor(sessionId),
      advertisedCommands: [
        ...builtinAvailableCommands(),
        ...this.#availableCommands.map(toAvailableCommand),
      ],
      inlineMessages: this.#inline.getMessages(),
      buildVersion: BUILD_VERSION,
      acpSdkVersion: ACP_SDK_VERSION,
    };
    let result;
    try {
      result = await match.cmd.handler(match.args, ctx);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result = {
        replyText: `Built-in \`/${match.cmd.name}\` failed: ${message}`,
      };
    }
    const meta = {
      bodhi: {
        builtin: {
          command: match.cmd.name,
          ...(result.action ? { action: result.action } : {}),
        },
      },
    };
    await this.#conn.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: result.replyText },
      },
      _meta: meta,
    } as SessionNotification);
    if (this.#store) {
      try {
        await this.#store.recordBuiltin(sessionId, {
          command: match.cmd.name,
          userText: rawText,
          replyText: result.replyText,
          ...(result.action ? { action: result.action } : {}),
        });
      } catch (err) {
        console.error('[acp-agent-adapter] failed to persist builtin entry:', err);
      }
    }
    return { stopReason: 'end_turn' };
  }

  #resolveBuiltinModelId(params: PromptRequest): string | null {
    // Best-effort: prefer the model id the client passed in this
    // turn's `_meta.bodhi.modelId`. Built-ins still work without a
    // model — handlers display `(none selected)`.
    const meta = (params._meta ?? {}) as BodhiPromptMeta;
    return meta.bodhi?.modelId ?? null;
  }

  async #sessionStatsFor(sessionId: string): Promise<{ turnCount: number; messageCount: number }> {
    const messageCount = this.#inline.getMessages().length;
    if (!this.#store) return { turnCount: 0, messageCount };
    try {
      const row = await this.#store.getSession(sessionId);
      return { turnCount: row?.turnCount ?? 0, messageCount };
    } catch {
      return { turnCount: 0, messageCount };
    }
  }

  #mcpConnectedFor(sessionId: string): string[] {
    const session = this.#sessions.get(sessionId);
    if (!session) return [];
    const out: string[] = [];
    for (const cfg of session.mcpServers) {
      if (this.#mcpPool.getClient(cfg)) out.push(cfg.name);
    }
    return out;
  }

  /**
   * Look at the last `text` content block in the prompt and, if it
   * starts with `/`, run agent-side slash-command expansion. The
   * literal `/cmd args` text is replaced with the expanded template
   * so the LLM sees the rendered prompt — not the slash invocation.
   *
   * No expansion when the cache is empty or no command matches; the
   * literal text passes through untouched and the LLM (or the user)
   * gets to decide what `/cmd` means.
   */
  #applySlashCommandExpansion(params: PromptRequest): void {
    if (this.#availableCommands.length === 0) return;
    const blocks = params.prompt;
    if (!Array.isArray(blocks)) return;
    for (let i = blocks.length - 1; i >= 0; i--) {
      const block = blocks[i];
      if (block && block.type === 'text' && typeof block.text === 'string') {
        if (!block.text.startsWith('/')) return;
        const result = expandCommand(block.text, this.#availableCommands);
        if (result.matched && typeof result.expanded === 'string') {
          block.text = result.expanded;
        }
        return;
      }
    }
  }

  /**
   * Single exit point for every `session/update` notification. Emits
   * to the client AND persists the notification in the session store
   * so `session/load` can re-emit the exact same bytes later.
   */
  async #emit(notification: SessionNotification): Promise<void> {
    await this.#conn.sessionUpdate(notification);
    if (this.#store) {
      try {
        await this.#store.recordNotification(notification.sessionId, notification);
      } catch (err) {
        console.error('[acp-agent-adapter] failed to persist notification:', err);
      }
    }
  }
}

/**
 * Wraps a tool so its `execute` signal is chained with the per-turn
 * cancellation signal owned by the adapter. pi-agent-core passes its
 * internal abort signal (for LLM streaming) into `execute`, but for
 * tool cancellation we also want the adapter's `session/cancel`
 * controller to short-circuit the current run (bash, MCP, or other).
 */
function bindAbortSignal<TParams extends TSchema, TDetails>(
  tool: AgentTool<TParams, TDetails>,
  turnSignal: AbortSignal
): AgentTool<TParams, TDetails> {
  const originalExecute = tool.execute.bind(tool);
  return {
    ...tool,
    execute: (
      toolCallId: string,
      params,
      signal?: AbortSignal,
      onUpdate?: AgentToolUpdateCallback<TDetails>
    ): Promise<AgentToolResult<TDetails>> => {
      const controller = new AbortController();
      if (turnSignal.aborted) controller.abort(turnSignal.reason);
      else
        turnSignal.addEventListener('abort', () => controller.abort(turnSignal.reason), {
          once: true,
        });
      if (signal) {
        if (signal.aborted) controller.abort(signal.reason);
        else
          signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
      }
      return originalExecute(toolCallId, params, controller.signal, onUpdate);
    },
  };
}

/**
 * Retain only `type: 'http'` servers from the raw ACP `McpServer`
 * union. web-acp advertises `mcpCapabilities.http = true` only, but
 * clients can still send stdio/sse entries — we drop them
 * deliberately rather than throwing so one misconfigured entry never
 * breaks a session.
 */
function filterHttpServers(servers: McpServer[]): McpServerHttp[] {
  const out: McpServerHttp[] = [];
  for (const server of servers) {
    if (!server || typeof server !== 'object') continue;
    if ('type' in server && server.type !== 'http') continue;
    if (!('url' in server) || typeof (server as { url: unknown }).url !== 'string') continue;
    // `McpServer::Http` when present always carries a string name and headers array.
    out.push({
      name: (server as { name: string }).name,
      url: (server as { url: string }).url,
      headers: (server as { headers?: Array<{ name: string; value: string }> }).headers ?? [],
    });
  }
  return out;
}

function poolEventToState(
  event: 'connecting' | 'connected' | 'error' | 'disconnected'
): 'connecting' | 'connected' | 'error' | 'disconnected' {
  return event;
}

/**
 * Convert a worker-side `McpToggleSnapshot` into the spec-surface
 * shape the wire contract expects. The worker stores empty maps as
 * `Record<string, ...>`; on the wire we want plain object literals
 * so existing JSON-RPC serialisation through
 * `AgentSideConnection.extMethod` doesn't drag unexpected keys.
 */
function toWireMcpToggles(snapshot: McpToggleSnapshot): BodhiMcpToggleSnapshot {
  return {
    servers: { ...snapshot.servers },
    tools: Object.fromEntries(
      Object.entries(snapshot.tools).map(([slug, toolMap]) => [slug, { ...toolMap }])
    ),
  };
}

function toAvailableCommand(def: CommandDef): AvailableCommand {
  const out: AvailableCommand = {
    name: def.name,
    description: def.description,
  };
  if (def.argumentHint) {
    out.input = { hint: def.argumentHint };
  }
  return out;
}

function toolTitle(toolName: string, args: unknown): string {
  if (toolName === 'bash') {
    const script = (args as { script?: unknown })?.script;
    if (typeof script === 'string' && script.trim().length > 0) {
      const line = script.split('\n')[0].trim();
      return `bash: ${line.length > 80 ? `${line.slice(0, 77)}…` : line}`;
    }
    return 'bash';
  }
  return toolName;
}

function toToolCallContent(
  content: Array<{ type?: unknown; text?: unknown }>
): AcpToolCallUpdate['content'] {
  const blocks = [];
  for (const part of content) {
    if (part && part.type === 'text' && typeof part.text === 'string') {
      blocks.push({
        type: 'content' as const,
        content: { type: 'text' as const, text: part.text },
      });
    }
  }
  return blocks.length > 0 ? (blocks as AcpToolCallUpdate['content']) : undefined;
}

function extractAssistantText(msg: CoreMessage): string {
  if (typeof msg.content === 'string') return msg.content;
  if (!Array.isArray(msg.content)) return '';
  const out: string[] = [];
  for (const part of msg.content) {
    if (
      part &&
      typeof part === 'object' &&
      'type' in part &&
      part.type === 'text' &&
      'text' in part
    ) {
      out.push(part.text as string);
    }
  }
  return out.join('');
}

function extractMessageId(msg: CoreMessage): string | undefined {
  const anyMsg = msg as unknown as { id?: unknown };
  return typeof anyMsg.id === 'string' ? anyMsg.id : undefined;
}

interface BuiltinTagShape {
  command: string;
  action?: { kind: string };
}

/**
 * Build a synthetic user message tagged for a built-in invocation
 * (M4 phase B). The `_builtin` field rides on the snapshot returned
 * by `bodhi/getSession`; the client reads it to render the bubble
 * muted with a "not sent to LLM" badge. The shape mirrors what
 * `useAcp.sendMessage` constructs locally for a live invocation.
 */
function makeBuiltinUserMessage(text: string, tag: BuiltinTagShape): AgentMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    _builtin: tag,
  } as unknown as AgentMessage;
}

function makeBuiltinAssistantMessage(text: string, tag: BuiltinTagShape): AgentMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    _builtin: tag,
  } as unknown as AgentMessage;
}
