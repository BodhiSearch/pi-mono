import { AgentSideConnection, ndJsonStream } from '@agentclientprotocol/sdk';
import { AcpAgentAdapter } from '../acp/agent-adapter';
import { assembleServices, type StreamOverridesRef } from '../acp/engine/services';
import { createInlineAgent } from '../agent/inline-agent';
import { createStreamFn } from '../agent/stream-fn';
import { ZenfsVolumeRegistry } from '../agent/volume-registry';
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

  const registry = new ZenfsVolumeRegistry();

  const services = assembleServices({
    inline,
    bodhi: options.provider,
    registry,
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

  // Mount initial volumes; first prompt sees them.
  const initialMount = registry.mountAll(options.volumes ?? []);

  return {
    async dispose() {
      await initialMount.catch(() => undefined);
      await adapter?.dispose();
    },
    async mount(init) {
      await initialMount.catch(() => undefined);
      await registry.mount(init);
    },
    async unmount(mountName) {
      await initialMount.catch(() => undefined);
      await registry.unmount(mountName);
    },
  };
}
