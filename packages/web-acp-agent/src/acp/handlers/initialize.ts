import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import type {
  AuthenticateRequest,
  AuthenticateResponse,
  InitializeRequest,
  InitializeResponse,
} from '@agentclientprotocol/sdk';
import { BODHI_AUTH_METHOD_ID, type BodhiAuthenticateMeta } from '../../wire';
import type { AcpAdapterContext } from './adapter-context';

const AGENT_NAME = '@bodhiapp/web-acp-agent';
const AGENT_TITLE = 'Bodhi Web ACP Agent';

export async function handleInitialize(
  ctx: AcpAdapterContext,
  params: InitializeRequest
): Promise<InitializeResponse> {
  const negotiatedVersion =
    params.protocolVersion <= PROTOCOL_VERSION ? params.protocolVersion : PROTOCOL_VERSION;
  return {
    protocolVersion: negotiatedVersion,
    agentInfo: {
      name: AGENT_NAME,
      title: AGENT_TITLE,
      version: ctx.buildVersion,
    },
    agentCapabilities: {
      loadSession: ctx.services.store !== undefined,
      mcpCapabilities: {
        http: true,
        sse: false,
      },
      promptCapabilities: {
        image: false,
        audio: false,
        embeddedContext: false,
      },
      sessionCapabilities: {
        list: ctx.services.store ? {} : null,
        close: {},
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

export async function handleAuthenticate(
  ctx: AcpAdapterContext,
  params: AuthenticateRequest
): Promise<AuthenticateResponse> {
  if (params.methodId !== BODHI_AUTH_METHOD_ID) {
    throw new Error(`Unsupported auth method: ${params.methodId}`);
  }
  const meta = (params._meta ?? {}) as Partial<BodhiAuthenticateMeta>;
  if (!meta.token || !meta.baseUrl) {
    throw new Error('authenticate: _meta must include { token, baseUrl }');
  }
  const providerInfo = await ctx.services.bodhi.setAuthToken?.({
    provider: 'bodhi',
    token: meta.token,
    baseUrl: meta.baseUrl,
  });
  ctx.services.lastProviderInfo = providerInfo;
  ctx.runtime.setModels([]);
  ctx.services.inline.clearMessages();
  return providerInfo !== undefined ? { _meta: { bodhi: { providerInfo } } } : {};
}
