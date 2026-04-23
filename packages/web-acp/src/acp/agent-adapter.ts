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
import type {
  AgentEvent,
  AgentMessage,
  AgentMessage as CoreMessage,
} from '@mariozechner/pi-agent-core';
import type { Api, Model } from '@mariozechner/pi-ai';
import type { BodhiProvider } from '@/agent/bodhi-provider';
import { apiFormatOfModel } from '@/agent/bodhi-provider';
import type { InlineAgent } from '@/agent/inline-agent';
import type { SessionStore } from '@/agent/session-store';
import { composeSystemPrompt } from '@/agent/system-prompt';
import type { VolumeRegistry } from '@/agent/volume-mount';
import {
  BODHI_AUTH_METHOD_ID,
  BODHI_GET_SESSION_METHOD,
  BODHI_LIST_MODELS_METHOD,
  BODHI_LIST_SESSIONS_METHOD,
  BODHI_VOLUMES_LIST_METHOD,
  type BodhiAuthenticateMeta,
  type BodhiGetSessionRequest,
  type BodhiGetSessionResponse,
  type BodhiListModelsResponse,
  type BodhiListSessionsResponse,
  type BodhiVolumesListResponse,
} from './index';

interface SessionState {
  id: string;
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
  readonly #sessions = new Map<string, SessionState>();
  #models: Model<Api>[] = [];
  #cancelled = false;
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
    registry?: VolumeRegistry
  ) {
    this.#conn = conn;
    this.#inline = inline;
    this.#bodhi = bodhi;
    this.#store = store;
    this.#registry = registry;
  }

  async initialize(_params: InitializeRequest): Promise<InitializeResponse> {
    return {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: this.#store !== undefined,
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

  async newSession(_params: NewSessionRequest): Promise<NewSessionResponse> {
    const sessionId = `bodhi-${crypto.randomUUID()}`;
    this.#sessions.set(sessionId, { id: sessionId });
    if (this.#store) {
      await this.#store.createSession(sessionId);
    }
    this.#inline.clearMessages();
    this.#activeInlineSessionId = sessionId;
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
    this.#sessions.set(params.sessionId, { id: params.sessionId });

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
    return {};
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const session = this.#sessions.get(params.sessionId);
    if (!session) {
      throw new Error(`Unknown session: ${params.sessionId}`);
    }

    const model = this.#resolveModel(params);
    if (!model) {
      throw new Error('No model selected: send session/prompt with _meta.bodhi.modelId');
    }

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

    const systemPrompt = this.#registry ? composeSystemPrompt(this.#registry.list()) : '';
    this.#inline.setModel(model, { tools: [], systemPrompt });

    const cursor: StreamCursor = { messageId: undefined, emittedLength: 0 };
    this.#cancelled = false;

    const unsubscribe = this.#inline.subscribe(event => {
      void this.#forwardEvent(params.sessionId, event, cursor);
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
    }
  }

  async cancel(_params: CancelNotification): Promise<void> {
    this.#cancelled = true;
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
      let messages: AgentMessage[] = [];
      for (const entry of entries) {
        if (entry.kind === 'turn') {
          const payload = entry.payload as { finalMessages?: AgentMessage[] };
          if (Array.isArray(payload.finalMessages)) {
            messages = payload.finalMessages;
          }
        }
      }
      const response: BodhiGetSessionResponse = {
        sessionId: row.id,
        messages,
        lastModelId: row.lastModelId,
        title: row.title,
      };
      return response;
    }
    throw new Error(`Unknown extension method: ${method}`);
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

  async #forwardEvent(sessionId: string, event: AgentEvent, cursor: StreamCursor): Promise<void> {
    if (event.type !== 'message_update') return;
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
