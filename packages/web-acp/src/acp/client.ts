import type {
  Client,
  ClientSideConnection,
  InitializeResponse,
  NewSessionResponse,
  PromptResponse,
  SessionNotification,
} from '@agentclientprotocol/sdk';
import {
  BODHI_AUTH_METHOD_ID,
  BODHI_LIST_MODELS_METHOD,
  type BodhiAuthenticateMeta,
  type BodhiListModelsResponse,
  type BodhiModelDescriptor,
} from './index';

export type SessionUpdateListener = (notification: SessionNotification) => void;

/**
 * Tiny wrapper over `ClientSideConnection` exposing just the calls
 * `useAcp` needs. Transport framing (ports, ndJSON) lives one layer up.
 * Phase C provides the skeleton; phase D wires it into the hook.
 */
export class AcpClient {
  readonly #conn: ClientSideConnection;
  readonly #listeners = new Set<SessionUpdateListener>();

  constructor(conn: ClientSideConnection) {
    this.#conn = conn;
  }

  get signal(): AbortSignal {
    return this.#conn.signal;
  }

  get closed(): Promise<void> {
    return this.#conn.closed;
  }

  async initialize(): Promise<InitializeResponse> {
    return this.#conn.initialize({
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
      },
    });
  }

  async authenticate(args: BodhiAuthenticateMeta): Promise<void> {
    await this.#conn.authenticate({
      methodId: BODHI_AUTH_METHOD_ID,
      _meta: { token: args.token, baseUrl: args.baseUrl },
    });
  }

  async listModels(): Promise<BodhiModelDescriptor[]> {
    const raw = await this.#conn.extMethod(BODHI_LIST_MODELS_METHOD, {});
    const payload = raw as BodhiListModelsResponse;
    return payload.models ?? [];
  }

  async newSession(): Promise<NewSessionResponse> {
    return this.#conn.newSession({ cwd: '/', mcpServers: [] });
  }

  async prompt(sessionId: string, text: string): Promise<PromptResponse> {
    return this.#conn.prompt({
      sessionId,
      prompt: [{ type: 'text', text }],
    });
  }

  async cancel(sessionId: string): Promise<void> {
    await this.#conn.cancel({ sessionId });
  }

  onSessionUpdate(listener: SessionUpdateListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * Exposed so the outer transport layer (the hook) can hand
   * session/update notifications back to subscribers.
   */
  dispatchSessionUpdate(notification: SessionNotification): void {
    for (const l of this.#listeners) {
      try {
        l(notification);
      } catch (err) {
        console.error('AcpClient listener threw:', err);
      }
    }
  }
}

export function buildClientHandler(client: AcpClient): Client {
  return {
    async sessionUpdate(params) {
      client.dispatchSessionUpdate(params);
    },
  };
}
