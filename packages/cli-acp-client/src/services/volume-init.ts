/**
 * Build a `VolumeInit` for an arbitrary host filesystem path. Used by
 * `/volume add <path>` and by the bootstrap path that re-mounts every
 * persisted volume on launch.
 *
 * Mirrors `createCwdVolumeInit` but parameterises the mount name and
 * the on-disk root. PassthroughFS rooted at `path` so /mnt/<name>/foo
 * maps to <path>/foo on disk.
 */

import * as nodeFs from 'node:fs';
import { PassthroughFS } from '@zenfs/core/backends/passthrough.js';
import type { VolumeInit } from '@bodhiapp/web-acp-agent';
import type { PersistedVolume } from '../storage/kv-keys';

type NodeFSShape = ConstructorParameters<typeof PassthroughFS>[0];

export function createPathVolumeInit(volume: PersistedVolume): VolumeInit {
  const passthrough = new PassthroughFS(nodeFs as unknown as NodeFSShape, volume.path);
  return {
    mountName: volume.mountName,
    description: `Mounted directory: ${volume.path}`,
    fs: passthrough,
  };
}
