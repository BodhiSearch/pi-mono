/**
 * Node-side assembly of `AcpAdapterServices`. Mirrors the worker's
 * `agent-worker.ts` startup but with Node-flavored substitutions:
 *   - sqlite-backed `SessionStore` / `FeatureStore` / `McpToggleStore`
 *     persisted at `<cwd>/.cli-acp-client/state.db`
 *   - `ZenfsVolumeRegistry` with `$cwd` + persisted volumes mounted
 *   - `BodhiProvider` + `createInlineAgent` for LLM streaming
 */

import { existsSync } from 'node:fs';
import {
  assembleServices,
  BodhiProvider,
  createInlineAgent,
  createStreamFn,
  type AcpAdapterServices,
  type StreamOptionOverrides,
  type VolumeInit,
  ZenfsVolumeRegistry,
} from '@bodhiapp/web-acp-agent';
import {
  KV_VOLUMES,
  createKvStore,
  createSqliteFeatureStore,
  createSqliteMcpToggleStore,
  createSqliteSessionStore,
  openAppDb,
  type AppDb,
  type KvStore,
  type PersistedVolume,
} from '../storage';
import { createCwdVolumeInit } from './cwd-volume';
import { createPathVolumeInit } from './volume-init';

export interface AssembleNodeServicesOptions {
  cwd: string;
  /**
   * Additional volumes to mount alongside `cwd`. Useful for tests that
   * want to seed an in-memory volume. Each entry is mounted at
   * `/mnt/<mountName>` after the registry is initialized.
   */
  extraVolumes?: VolumeInit[];
  /**
   * Disable auto-mount of `$cwd`. Tests use this to keep the volume
   * surface deterministic.
   */
  skipCwdVolume?: boolean;
  /**
   * Override the on-disk sqlite filename. Tests pass `:memory:` for an
   * isolated DB that doesn't pollute the cwd.
   */
  dbFilename?: string;
}

export interface AssembledNodeServices {
  services: AcpAdapterServices;
  provider: BodhiProvider;
  db: AppDb;
  kv: KvStore;
}

export async function assembleNodeServices(
  opts: AssembleNodeServicesOptions
): Promise<AssembledNodeServices> {
  const provider = new BodhiProvider();
  const streamOverrides: { current: StreamOptionOverrides } = { current: {} };
  const inline = createInlineAgent(
    createStreamFn(provider, () => {
      const snapshot = streamOverrides.current;
      streamOverrides.current = {};
      return snapshot;
    })
  );

  const db = openAppDb(opts.cwd, {
    filename: opts.dbFilename,
    inMemory: opts.dbFilename === ':memory:',
  });
  const kv = createKvStore(db);

  const registry = new ZenfsVolumeRegistry();
  const initialVolumes: VolumeInit[] = [];
  if (!opts.skipCwdVolume) {
    initialVolumes.push(createCwdVolumeInit({ cwd: opts.cwd }));
  }
  for (const persisted of kv.get<PersistedVolume[]>(KV_VOLUMES) ?? []) {
    if (!persisted || typeof persisted.path !== 'string') continue;
    if (!existsSync(persisted.path)) continue;
    initialVolumes.push(createPathVolumeInit(persisted));
  }
  if (opts.extraVolumes) {
    initialVolumes.push(...opts.extraVolumes);
  }
  await registry.mountAll(initialVolumes);

  const services = assembleServices({
    inline,
    bodhi: provider,
    store: createSqliteSessionStore(db),
    registry,
    features: createSqliteFeatureStore(db),
    mcpToggles: createSqliteMcpToggleStore(db),
    streamOverrides,
  });

  return { services, provider, db, kv };
}
