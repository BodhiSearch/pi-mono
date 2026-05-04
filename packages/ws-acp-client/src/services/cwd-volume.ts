/**
 * Auto-mounted volume backed by the host's `$cwd` on the real filesystem.
 *
 * Uses ZenFS's `Passthrough` backend to delegate every operation to
 * Node's `fs` module rooted at `$cwd`. From the agent's perspective the
 * volume looks like any other ZenFS mount under `/mnt/cwd`.
 *
 * Mirrors `packages/cli-acp-client/src/services/cwd-volume.ts`.
 */

import * as nodeFs from "node:fs";
import type { VolumeInit } from "@bodhiapp/web-acp-agent";
import { PassthroughFS } from "@zenfs/core/backends/passthrough.js";

export const CWD_VOLUME_NAME = "cwd";

export interface CwdVolumeOptions {
	cwd: string;
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
