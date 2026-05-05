import { AgentSideConnection, ndJsonStream } from '@agentclientprotocol/sdk';
import { AcpAgentAdapter } from '../acp/agent-adapter';
import {
  type ActiveSessionRef,
  assembleServices,
  type StreamOverridesRef,
} from '../acp/engine/services';
import type { ExtensionRegistry } from '../agent/extensions';
import { createInlineAgent } from '../agent/inline-agent';
import {
  createStreamFn,
  type ExtensionProviderResolution,
  type StreamProviderHooks,
} from '../agent/stream-fn';
import { createInMemoryPreferenceStore, createInMemorySessionStore } from '../storage/in-memory';
import { ACP_SDK_VERSION } from './sdk-version';
import type { StartAgentHandle, StartAgentOptions } from './types';

export function startAgent(options: StartAgentOptions): StartAgentHandle {
  const streamOverrides: StreamOverridesRef = { current: {} };
  const activeSession: ActiveSessionRef = { current: null };
  const inline = createInlineAgent(
    createStreamFn(
      options.provider,
      () => {
        const snapshot = streamOverrides.current;
        streamOverrides.current = {};
        return snapshot;
      },
      () => buildProviderHooks(options.extensions, activeSession),
      model => resolveExtensionProvider(options.extensions, model.id)
    )
  );

  const services = assembleServices({
    inline,
    bodhi: options.provider,
    registry: options.registry,
    extensions: options.extensions,
    extensionsWriteFs: options.extensionsWriteFs,
    store: options.sessions ?? createInMemorySessionStore(),
    preferences: options.preferences ?? createInMemoryPreferenceStore(),
    streamOverrides,
    activeSession,
  });

  const stream = ndJsonStream(options.transport.writable, options.transport.readable);
  let adapter: AcpAgentAdapter | undefined;
  new AgentSideConnection(conn => {
    adapter = new AcpAgentAdapter(conn, services, {
      buildVersion: options.buildVersion ?? '0.0.0',
      acpSdkVersion: ACP_SDK_VERSION,
    });
    return adapter;
  }, stream);

  return {
    async dispose() {
      await adapter?.dispose();
    },
  };
}

/**
 * Bridge between `streamSimple`'s `onPayload` / `onResponse` hooks
 * and the extension registry. Returns `undefined` when no
 * extensions are registered or when no session is active so the
 * stream call avoids paying the dispatch round-trip.
 */
function buildProviderHooks(
  extensions: ExtensionRegistry | undefined,
  activeSession: ActiveSessionRef
): StreamProviderHooks | undefined {
  if (!extensions) return undefined;
  const sessionId = activeSession.current;
  if (!sessionId) return undefined;
  return {
    async onPayload(payload) {
      return extensions.dispatchBeforeProviderRequest({
        type: 'before_provider_request',
        sessionId,
        payload,
      });
    },
    async onResponse(response) {
      await extensions.dispatchAfterProviderResponse({
        type: 'after_provider_response',
        sessionId,
        status: response.status,
        headers: response.headers ?? {},
      });
    },
  };
}

/**
 * Resolve the extension-owned provider for a model id. Returns the
 * shape `createStreamFn` expects (`apiKey`, `headers`, optional
 * `streamSimple`). Falls back to `null` so the stream-fn calls the
 * host `LlmProvider.getApiKeyAndHeaders`.
 */
function resolveExtensionProvider(
  extensions: ExtensionRegistry | undefined,
  modelId: string
): ExtensionProviderResolution | null {
  if (!extensions) return null;
  const match = extensions.findProviderForModel(modelId);
  if (!match) return null;
  const cfg = match.config;
  const headers = mergeProviderHeaders(cfg.headers, match.model.headers);
  return {
    apiKey: cfg.apiKey ?? '',
    headers,
    authHeader: cfg.authHeader ?? false,
    streamSimple: cfg.streamSimple,
  };
}

function mergeProviderHeaders(
  base: Record<string, string> | undefined,
  perModel: Record<string, string> | undefined
): Record<string, string> | undefined {
  if (!base && !perModel) return undefined;
  return { ...base, ...perModel };
}
