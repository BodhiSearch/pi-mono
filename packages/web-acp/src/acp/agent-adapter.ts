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
} from '@agentclientprotocol/sdk';
import type { Api, Model } from '@mariozechner/pi-ai';
import type { BodhiProvider } from '@/agent/bodhi-provider';
import { apiFormatOfModel } from '@/agent/bodhi-provider';
import type { InlineAgent } from '@/agent/inline-agent';
import {
  BODHI_AUTH_METHOD_ID,
  BODHI_LIST_MODELS_METHOD,
  type BodhiAuthenticateMeta,
  type BodhiListModelsResponse,
} from './index';

interface SessionState {
  id: string;
  model?: Model<Api>;
}

/**
 * ACP agent handler that bridges the inline pi-agent-core runtime to the
 * protocol. Phase C only defines the skeleton surface; phase D fills in
 * the `prompt` / session-update translation.
 */
export class AcpAgentAdapter implements Agent {
  readonly #conn: AgentSideConnection;
  readonly #inline: InlineAgent;
  readonly #bodhi: BodhiProvider;
  readonly #sessions = new Map<string, SessionState>();
  #models: Model<Api>[] = [];
  #unsubscribe: (() => void) | null = null;

  constructor(conn: AgentSideConnection, inline: InlineAgent, bodhi: BodhiProvider) {
    this.#conn = conn;
    this.#inline = inline;
    this.#bodhi = bodhi;
    void this.#conn;
    void this.#inline;
    void this.#sessions;
    void this.#unsubscribe;
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
    return {};
  }

  async newSession(_params: NewSessionRequest): Promise<NewSessionResponse> {
    const sessionId = `bodhi-${crypto.randomUUID()}`;
    this.#sessions.set(sessionId, { id: sessionId });
    return { sessionId };
  }

  async prompt(_params: PromptRequest): Promise<PromptResponse> {
    // Filled in during phase D.
    throw new Error('AcpAgentAdapter.prompt not yet implemented (phase D)');
  }

  async cancel(_params: CancelNotification): Promise<void> {
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
    throw new Error(`Unknown extension method: ${method}`);
  }
}
