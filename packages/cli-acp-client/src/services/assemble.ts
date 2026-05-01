/**
 * Node-side assembly of `AcpAdapterServices`. Mirrors the worker's
 * `agent-worker.ts` startup but with Node-flavored substitutions:
 *   - in-memory `SessionStore` / `FeatureStore` / `McpToggleStore`
 *   - `ZenfsVolumeRegistry` with the `$cwd` volume mounted by default
 *   - `BodhiProvider` + `createInlineAgent` for LLM streaming
 */

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
import { createCwdVolumeInit } from './cwd-volume';
import {
  createInMemoryFeatureStore,
  createInMemoryMcpToggleStore,
  createInMemorySessionStore,
} from './stores';

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
}

export interface AssembledNodeServices {
  services: AcpAdapterServices;
  provider: BodhiProvider;
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
  const registry = new ZenfsVolumeRegistry();
  const initialVolumes: VolumeInit[] = [];
  if (!opts.skipCwdVolume) {
    initialVolumes.push(createCwdVolumeInit({ cwd: opts.cwd }));
  }
  if (opts.extraVolumes) {
    initialVolumes.push(...opts.extraVolumes);
  }
  await registry.mountAll(initialVolumes);

  const services = assembleServices({
    inline,
    bodhi: provider,
    store: createInMemorySessionStore(),
    registry,
    features: createInMemoryFeatureStore(),
    mcpToggles: createInMemoryMcpToggleStore(),
    streamOverrides,
  });

  return { services, provider };
}
