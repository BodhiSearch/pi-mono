/**
 * Auto-mounted volume backed by the user's `$cwd` on the real filesystem.
 *
 * Uses ZenFS's `Passthrough` backend to delegate every operation to
 * Node's `fs` module rooted at `$cwd`. From the agent's perspective the
 * volume looks like any other ZenFS mount under `/mnt/cwd`; the bash
 * tool, vault command loader, and `fs/*` helpers all see the user's
 * project files directly.
 *
 * v0 has no sandboxing — paths under `/mnt/cwd` map straight through to
 * `cwd/...` on disk. Hardening (read-only mode, allow-list, deny-list)
 * is a separate pass.
 */

import * as nodeFs from 'node:fs';
import { PassthroughFS } from '@zenfs/core/backends/passthrough.js';
import type { VolumeInit } from '@bodhiapp/web-acp-agent';

export const CWD_VOLUME_NAME = 'cwd';

export interface CwdVolumeOptions {
  cwd: string;
  /** Override the volume's display name (defaults to `cwd`). */
  mountName?: string;
}

type NodeFSShape = ConstructorParameters<typeof PassthroughFS>[0];

export function createCwdVolumeInit(opts: CwdVolumeOptions): VolumeInit {
  const passthrough = new PassthroughFS(nodeFs as unknown as NodeFSShape, opts.cwd);
  return {
    mountName: opts.mountName ?? CWD_VOLUME_NAME,
    description: `Working directory: ${opts.cwd}`,
    fs: passthrough,
  };
}
