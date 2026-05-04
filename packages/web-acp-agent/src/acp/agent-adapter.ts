import type {
  Agent,
  AgentSideConnection,
  AuthenticateRequest,
  AuthenticateResponse,
  CancelNotification,
  CloseSessionRequest,
  CloseSessionResponse,
  InitializeRequest,
  InitializeResponse,
  ListSessionsRequest,
  ListSessionsResponse,
  LoadSessionRequest,
  LoadSessionResponse,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  SetSessionConfigOptionRequest,
  SetSessionConfigOptionResponse,
  SetSessionModelRequest,
  SetSessionModelResponse,
} from '@agentclientprotocol/sdk';
import { dispatchExtMethod } from './engine/ext-methods';
import { PromptTurnDriver } from './engine/prompt-driver';
import type { AcpAdapterServices } from './engine/services';
import { AcpSessionRuntime } from './engine/session-runtime';
import type { ExtMethodHost } from './engine/types';
import type { AcpAdapterContext } from './handlers/adapter-context';
import { handleAuthenticate, handleInitialize } from './handlers/initialize';
import {
  handleCancel,
  handleCloseSession,
  handleListSessions,
  handleLoadSession,
  handleNewSession,
  handleSetSessionConfigOption,
  handleSetSessionModel,
} from './handlers/session-crud';

export interface AcpAgentAdapterOptions {
  /** Build version string of the host runtime; reported by `/version` and `agentInfo`. */
  buildVersion: string;
  /** Version of the `@agentclientprotocol/sdk` package the host bundles; reported by `/version`. */
  acpSdkVersion: string;
}

/**
 * ACP wire shim. Holds no business logic — owns the runtime + driver
 * and routes SDK `Agent` callbacks at handlers via a shared
 * `AcpAdapterContext`. Build constants are explicit constructor
 * options so the adapter can be hosted by any runtime without
 * leaking build-tool assumptions.
 */
export class AcpAgentAdapter implements Agent {
  readonly #services: AcpAdapterServices;
  readonly #runtime: AcpSessionRuntime;
  readonly #driver: PromptTurnDriver;
  readonly #ctx: AcpAdapterContext;

  constructor(
    conn: AgentSideConnection,
    services: AcpAdapterServices,
    options: AcpAgentAdapterOptions
  ) {
    this.#services = services;
    this.#runtime = new AcpSessionRuntime(conn, services);
    this.#driver = new PromptTurnDriver({
      conn,
      services,
      runtime: this.#runtime,
      buildVersion: options.buildVersion,
      acpSdkVersion: options.acpSdkVersion,
    });
    this.#ctx = {
      services,
      runtime: this.#runtime,
      driver: this.#driver,
      buildVersion: options.buildVersion,
    };
  }

  initialize(params: InitializeRequest): Promise<InitializeResponse> {
    return handleInitialize(this.#ctx, params);
  }

  authenticate(params: AuthenticateRequest): Promise<AuthenticateResponse> {
    return handleAuthenticate(this.#ctx, params);
  }

  newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    return handleNewSession(this.#ctx, params);
  }

  loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    return handleLoadSession(this.#ctx, params);
  }

  listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse> {
    return handleListSessions(this.#ctx, params);
  }

  closeSession(params: CloseSessionRequest): Promise<CloseSessionResponse> {
    return handleCloseSession(this.#ctx, params);
  }

  unstable_setSessionModel(params: SetSessionModelRequest): Promise<SetSessionModelResponse> {
    return handleSetSessionModel(this.#ctx, params);
  }

  setSessionConfigOption(
    params: SetSessionConfigOptionRequest
  ): Promise<SetSessionConfigOptionResponse> {
    return handleSetSessionConfigOption(this.#ctx, params);
  }

  prompt(params: PromptRequest): Promise<PromptResponse> {
    return this.#driver.run(params);
  }

  cancel(params: CancelNotification): Promise<void> {
    return handleCancel(this.#ctx, params);
  }

  extMethod(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    return dispatchExtMethod(method, params, this.#extMethodHost());
  }

  // Bridge adapter/runtime accessors so per-handler files stay
  // independent of the adapter class.
  #extMethodHost(): ExtMethodHost {
    const runtime = this.#runtime;
    return {
      bodhi: this.#services.bodhi,
      store: this.#services.store,
      registry: this.#services.registry,
      preferences: this.#services.preferences,
      mcpPool: this.#services.mcpPool,
      inline: this.#services.inline,
      sessions: runtime.sessions,
      getModels: () => runtime.getModels(),
      setModels: m => runtime.setModels(m),
      getActiveInlineSessionId: () => runtime.getActiveInlineSessionId(),
      setActiveInlineSessionId: id => runtime.setActiveInlineSessionId(id),
      readFeatures: sessionId => runtime.readFeatures(sessionId),
      readMcpToggles: sessionId => runtime.readMcpToggles(sessionId),
      tearDownSession: (sessionId, opts) => runtime.tearDownSession(sessionId, opts),
      abortPromptIfActive: sessionId => this.#driver.abortIfActive(sessionId),
    };
  }

  /**
   * Releases MCP refcounts and tears down runtime subscriptions.
   * Does NOT abort in-flight turns — that's the cancel/close path.
   * Host must cancel active sessions before calling. Idempotent.
   */
  async dispose(): Promise<void> {
    await this.#runtime.dispose();
  }
}
