import { AgentSideConnection, ndJsonStream } from '@agentclientprotocol/sdk';
import { AcpAgentAdapter } from '../acp/agent-adapter';
import { assembleServices, type StreamOverridesRef } from '../acp/engine/services';
import { createInlineAgent } from '../agent/inline-agent';
import { createStreamFn } from '../agent/stream-fn';
import { createInMemoryPreferenceStore, createInMemorySessionStore } from '../storage/in-memory';
import { ACP_SDK_VERSION } from './sdk-version';
import type { StartAgentHandle, StartAgentOptions } from './types';

export function startAgent(options: StartAgentOptions): StartAgentHandle {
  const streamOverrides: StreamOverridesRef = { current: {} };
  const inline = createInlineAgent(
    createStreamFn(options.provider, () => {
      const snapshot = streamOverrides.current;
      streamOverrides.current = {};
      return snapshot;
    })
  );

  const services = assembleServices({
    inline,
    bodhi: options.provider,
    registry: options.registry,
    store: options.sessions ?? createInMemorySessionStore(),
    preferences: options.preferences ?? createInMemoryPreferenceStore(),
    streamOverrides,
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
