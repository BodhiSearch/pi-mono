/**
 * Stable string keys for the `kv` JSON-blob table. The table holds
 * host-only state that doesn't fit the agent's row-shaped stores:
 * the user-requested MCP URL list, the most recently used model id,
 * and the persisted volume mount list.
 *
 * Values are JSON-encoded by `KvStore`. Each key has a fixed value
 * shape documented inline; rename a key and you must add a migration.
 */

/** `string[]` — MCP URLs the user has asked Bodhi to provision. */
export const KV_REQUESTED_MCPS = 'requestedMcps';

/** `string` — most recently selected model id, surfaced as default on next launch. */
export const KV_LAST_MODEL_ID = 'lastModelId';

/** `Array<{ mountName: string; path: string }>` — non-cwd volumes added via /volume add. */
export const KV_VOLUMES = 'volumes';

export interface PersistedVolume {
  mountName: string;
  path: string;
}
