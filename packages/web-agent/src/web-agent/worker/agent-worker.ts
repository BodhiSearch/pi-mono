/**
 * Web Worker entry — owns the agent runtime, its tool execution, and the
 * real ZenFS mount.
 *
 * Boot sequence:
 *   1. Wait for the init message on the global self port.
 *   2. Construct an AgentSession + WorkerAgentHost.
 *   3. Bind the agent RPC server to the agent port.
 *   4. If a dev seed was provided, mount the InMemory ZenFS backend
 *      immediately. Otherwise, the host waits for `mount_vault(handle)`
 *      from the main thread.
 *
 * Everything inside this Worker shares one JS context with the agent and
 * the ZenFS backend, so vault tool execution touches the filesystem
 * directly without any per-call RPC hop. MCP tools are the exception —
 * they upcall to the main thread via the existing agent RPC channel.
 */

import { streamSimple } from '@mariozechner/pi-ai';
import type { StreamFn } from '@mariozechner/pi-agent-core';
import { AgentSession } from '../core/agent-session';
import { RpcServer } from '../rpc/rpc-server';
import { isAgentWorkerInit } from './init-protocol';
import { WorkerAgentHost } from './worker-host';

const SENTINEL_API_KEY = 'bodhiapp_sentinel_api_key_ignored';

self.addEventListener('message', event => {
  const data = event.data;
  if (!isAgentWorkerInit(data)) return;
  boot(data.agentPort, data.vfsPort, data.devSeed).catch(err => {
    console.error('[agent-worker] boot failed:', err);
  });
});

async function boot(
  agentPort: MessagePort,
  vfsPort: MessagePort,
  devSeed: import('./init-protocol').InMemoryVaultSeed | undefined
): Promise<void> {
  const session = new AgentSession({
    getApiKey: () => SENTINEL_API_KEY,
  });
  // Build the streamFn here — closes over session.getAuthToken() so token
  // rotation pushed via set_auth_token takes effect on the next request.
  session.setStreamFn(makeStreamFn(session));

  // Both ports were transferred via postMessage; addEventListener-based
  // listeners require an explicit start() before delivery begins.
  vfsPort.start();

  const host = new WorkerAgentHost(session, vfsPort);

  agentPort.start();
  const transport = {
    send(message: unknown) {
      agentPort.postMessage(message);
    },
    onMessage(handler: (message: unknown) => void): () => void {
      const listener = (e: MessageEvent) => handler(e.data);
      agentPort.addEventListener('message', listener);
      return () => agentPort.removeEventListener('message', listener);
    },
    close() {
      agentPort.close();
    },
  };

  // Server retains itself via the transport's listener closure.
  new RpcServer(transport, host);

  if (devSeed) {
    try {
      await host.mountDevSeed(devSeed);
    } catch (err) {
      console.error('[agent-worker] dev seed mount failed:', err);
    }
  }
}

function makeStreamFn(session: AgentSession): StreamFn {
  return (model, context, options) => {
    const token = session.getAuthToken();
    const headers = token
      ? { ...model.headers, Authorization: `Bearer ${token}`, 'x-api-key': token }
      : model.headers;
    const patched = headers !== model.headers ? { ...model, headers } : model;
    return streamSimple(patched, context, options);
  };
}
