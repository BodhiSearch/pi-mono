import type { Client } from '@agentclientprotocol/sdk';

/**
 * Stub for ACP `session/request_permission`. The bridge is deferred —
 * see `ai-docs/web-acp/milestones/deferred.md` for the pre-execution
 * classifier + allow-always persistence design.
 *
 * Until then the worker's `bash` tool runs commands as-is, so the host
 * client never sees a real prompt — but we still implement the handler
 * so an externally-connected ACP agent speaking the same wire surface
 * receives a spec-conforming `cancelled` outcome (per ACP
 * tool-calls.mdx) instead of an opaque JSON-RPC error.
 */
export const requestPermissionStub: Client['requestPermission'] = async () => ({
  outcome: { outcome: 'cancelled' },
});
