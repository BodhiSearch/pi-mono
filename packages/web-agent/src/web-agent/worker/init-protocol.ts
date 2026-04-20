/**
 * Init message contract between the main thread and the agent Worker.
 *
 * Main thread posts an `AgentWorkerInit` to the Worker once, transferring
 * both MessagePorts. The Worker wires up:
 *   - `agentPort` → RpcServer ↔ AgentSession
 *   - `vfsPort` → ZenFS Port backend (real WebAccess or InMemory)
 *
 * Single message, both ports transferred together. Cribbed from Comlink:
 * tag the envelope with a unique discriminator so the Worker can ignore
 * unrelated messages from other libraries (or future extension protocols).
 */

export const AGENT_WORKER_INIT_TYPE = '__webAgent_init';

export interface InMemoryVaultSeed {
  files: Record<string, string>;
  name: string;
}

/**
 * Library-level configuration options. Passed through the Worker init
 * envelope so both the main thread and the Worker agree on the concrete
 * values without either side hard-coding defaults in business logic.
 */
export interface WebAgentOptions {
  /** ZenFS mount path for the user's vault. Defaults to `/vault`. */
  vaultMount?: string;
  /** Dexie IDB database name for session storage. Defaults to `web-agent`. */
  sessionsDbName?: string;
}

export interface AgentWorkerInit {
  type: typeof AGENT_WORKER_INIT_TYPE;
  agentPort: MessagePort;
  vfsPort: MessagePort;
  /**
   * Dev-only InMemory vault seed. When present, the Worker mounts an
   * InMemory ZenFS backend immediately at init and seeds the files. Skips
   * the FSA `mount_vault` flow.
   */
  devSeed?: InMemoryVaultSeed;
  /** Library-level options forwarded from `getAgentWorker()`. */
  options?: WebAgentOptions;
}

export function isAgentWorkerInit(value: unknown): value is AgentWorkerInit {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.type === AGENT_WORKER_INIT_TYPE &&
    v.agentPort instanceof MessagePort &&
    v.vfsPort instanceof MessagePort
  );
}
