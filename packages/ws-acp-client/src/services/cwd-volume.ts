/**
 * Auto-mounted volume backed by a host-side directory on the real filesystem.
 *
 * Uses ZenFS's `Passthrough` backend to delegate every operation to
 * Node's `fs` module rooted at `cwd`. From the agent's perspective the
 * volume looks like any other ZenFS mount under `/mnt/<mountName>`.
 *
 * Used for both the auto-mounted `/mnt/cwd` (the agent's process cwd)
 * and any extra `--volume name=path` mounts the CLI plumbs through.
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
	description?: string;
}

type NodeFSShape = ConstructorParameters<typeof PassthroughFS>[0];

export function createCwdVolumeInit(opts: CwdVolumeOptions): VolumeInit {
	const passthrough = new PassthroughFS(nodeFs as unknown as NodeFSShape, opts.cwd);
	const mountName = opts.mountName ?? CWD_VOLUME_NAME;
	const description =
		opts.description ??
		(mountName === CWD_VOLUME_NAME ? `Working directory: ${opts.cwd}` : `Mounted directory: ${opts.cwd}`);
	return {
		mountName,
		description,
		fs: passthrough,
	};
}
