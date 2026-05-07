import {
  type AuthenticateResponse,
  type Client,
  type InitializeResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
} from '@agentclientprotocol/sdk';
import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import {
  BODHI_AUTH_METHOD_ID,
  BodhiProvider,
  createInMemoryDuplex,
  type SessionStore,
  startAgent,
  type StartAgentHandle,
  ZenfsVolumeRegistry,
} from '@bodhiapp/web-acp-agent';
import {
  buildSeedInit,
  createInMemoryPreferenceStore,
  createInMemorySessionStore,
  type SeedSpec,
} from '@bodhiapp/web-acp-agent/test-utils';
import { NotificationBuffer } from './notification-buffer';

export interface EmbeddedAgent {
  client: ClientSideConnection;
  notifications: NotificationBuffer;
  sessions: SessionStore;
  initialize(): Promise<InitializeResponse>;
  authenticate(opts: { token: string; baseUrl: string }): Promise<AuthenticateResponse>;
  dispose(): Promise<void>;
}

export interface EmbedAgentOptions {
  volumes?: SeedSpec[];
  sessionStore?: SessionStore;
  isDev?: boolean;
}

export async function embedAgent(opts: EmbedAgentOptions = {}): Promise<EmbeddedAgent> {
  const duplex = createInMemoryDuplex();
  const provider = new BodhiProvider();
  const registry = new ZenfsVolumeRegistry();

  if (opts.volumes && opts.volumes.length > 0) {
    await registry.mountAll(opts.volumes.map(buildSeedInit));
  }

  const sessions = opts.sessionStore ?? createInMemorySessionStore();
  const preferences = createInMemoryPreferenceStore();

  const handle: StartAgentHandle = startAgent({
    transport: duplex.agent,
    provider,
    registry,
    sessions,
    preferences,
    buildVersion: '0.0.0-e2e',
  });

  const stream = ndJsonStream(duplex.client.writable, duplex.client.readable);
  const notifications = new NotificationBuffer();
  const handler: Client = {
    async requestPermission(_req: RequestPermissionRequest): Promise<RequestPermissionResponse> {
      return { outcome: { outcome: 'cancelled' } };
    },
    async sessionUpdate(notification: SessionNotification): Promise<void> {
      notifications.pushSessionUpdate(notification);
    },
    async writeTextFile() {
      throw new Error('writeTextFile not supported in headless e2e');
    },
    async readTextFile() {
      throw new Error('readTextFile not supported in headless e2e');
    },
  };
  const handlerWithExt: Client = {
    ...handler,
    extNotification: async (method: string, params: Record<string, unknown>) => {
      notifications.pushExtNotification(method, params);
    },
  };
  const client = new ClientSideConnection(() => handlerWithExt, stream);

  return {
    client,
    notifications,
    sessions,
    initialize: () =>
      client.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
      }),
    authenticate: ({ token, baseUrl }) =>
      client.authenticate({
        methodId: BODHI_AUTH_METHOD_ID,
        _meta: { token, baseUrl },
      }),
    dispose: async () => {
      await handle.dispose().catch(() => {});
      await closeStream(duplex.client.writable);
      await closeStream(duplex.agent.writable);
    },
  };
}

async function closeStream(stream: WritableStream<Uint8Array>): Promise<void> {
  try {
    const writer = stream.getWriter();
    await writer.close();
    writer.releaseLock();
  } catch {
    // already closed
  }
}
