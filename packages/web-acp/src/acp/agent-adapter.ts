import type {
  Agent,
  AgentSideConnection,
  AuthenticateRequest,
  AuthenticateResponse,
  CancelNotification,
  InitializeRequest,
  InitializeResponse,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  SessionNotification,
} from '@agentclientprotocol/sdk';
import type { AgentEvent, AgentMessage as CoreMessage } from '@mariozechner/pi-agent-core';
import type { Api, Model } from '@mariozechner/pi-ai';
import type { BodhiProvider } from '@/agent/bodhi-provider';
import { apiFormatOfModel } from '@/agent/bodhi-provider';
import type { InlineAgent } from '@/agent/inline-agent';
import type { SessionStore } from '@/agent/session-store';
import {
  BODHI_AUTH_METHOD_ID,
  BODHI_LIST_MODELS_METHOD,
  BODHI_LIST_SESSIONS_METHOD,
  type BodhiAuthenticateMeta,
  type BodhiListModelsResponse,
  type BodhiListSessionsResponse,
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
  readonly #sessions = new Map<string, SessionState>();
  #models: Model<Api>[] = [];
  #cancelled = false;

  constructor(
    conn: AgentSideConnection,
    inline: InlineAgent,
    bodhi: BodhiProvider,
    store?: SessionStore
  ) {
    this.#conn = conn;
    this.#inline = inline;
    this.#bodhi = bodhi;
    this.#store = store;
  }

  async initialize(_params: InitializeRequest): Promise<InitializeResponse> {
    return {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: false,
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
    return { sessionId };
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

    this.#inline.setModel(model);

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
    throw new Error(`Unknown extension method: ${method}`);
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
