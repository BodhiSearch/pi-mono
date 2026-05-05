import { fs, InMemory } from '@zenfs/core';
import { WebAccess } from '@zenfs/dom';
import type { VolumeInit } from '@bodhiapp/web-acp-agent';
import type { HostVolumeInit, VolumeSeed } from './types';

/**
 * Convert a browser-host `HostVolumeInit` (FSA handle or in-memory
 * seed) into the agent package's transport-agnostic `VolumeInit`
 * (carries a constructed ZenFS `FileSystem` plus an optional
 * `initialize` post-mount hook).
 *
 * Keeping the FSA-specific code here means the agent package never
 * imports `@zenfs/dom`, so the same agent can be hosted on a Node
 * runtime that swaps in a different backend factory.
 */
export async function toAgentVolumeInit(host: HostVolumeInit): Promise<VolumeInit> {
  const tags = host.tags ?? host.seed?.tags;
  const tagPatch = tags && tags.length > 0 ? { tags } : {};
  if (host.handle) {
    const filesystem = await WebAccess.create({ handle: host.handle });
    return {
      mountName: host.mountName,
      ...(host.description ? { description: host.description } : {}),
      ...tagPatch,
      fs: filesystem,
    };
  }
  if (host.seed) {
    const seed = host.seed;
    const filesystem = InMemory.create({ label: seed.name });
    return {
      mountName: host.mountName,
      ...(host.description ? { description: host.description } : {}),
      ...tagPatch,
      fs: filesystem,
      initialize: () => seedInMemoryBackend(`/mnt/${host.mountName}`, seed),
    };
  }
  throw new Error(`Volume '${host.mountName}' needs either a handle or a seed`);
}

async function seedInMemoryBackend(mountPath: string, seed: VolumeSeed): Promise<void> {
  const entries = Object.keys(seed.files).sort();
  for (const rel of entries) {
    const absolute = rel.startsWith('/')
      ? joinMount(mountPath, rel)
      : joinMount(mountPath, `/${rel}`);
    const lastSlash = absolute.lastIndexOf('/');
    if (lastSlash > 0) {
      const parent = absolute.slice(0, lastSlash);
      try {
        await fs.promises.mkdir(parent, { recursive: true });
      } catch (err: unknown) {
        if (!isExistsError(err)) throw err;
      }
    }
    await fs.promises.writeFile(absolute, seed.files[rel], { encoding: 'utf8' });
  }
}

function joinMount(mountPath: string, relative: string): string {
  // Seed keys may already be written as `/mnt/<name>/…` (web-agent
  // legacy shape) or as `/…` scoped to the volume root. Both resolve
  // to the same absolute path after normalising the `mnt/<name>` prefix.
  if (relative.startsWith(`${mountPath}/`)) return relative;
  return `${mountPath}${relative.startsWith('/') ? '' : '/'}${relative}`;
}

function isExistsError(err: unknown): boolean {
  return (
    err !== null &&
    typeof err === 'object' &&
    'code' in err &&
    (err as { code?: string }).code === 'EEXIST'
  );
}
