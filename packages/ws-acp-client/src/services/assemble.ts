/**
 * Process-wide host state shared by every WS connection: sqlite `AppDb`
 * (sessions + preferences) plus one `ZenfsVolumeRegistry` with `/mnt/cwd`
 * pre-mounted. Per-connection wiring lives in `server.ts`.
 */

import { type VolumeInit, ZenfsVolumeRegistry } from "@bodhiapp/web-acp-agent";
import { type AppDb, openAppDb } from "../storage";
import { createCwdVolumeInit } from "./cwd-volume";

export interface CreateHostStateOptions {
	cwd: string;
	/** Additional volumes mounted alongside `$cwd`. Tests use this to
	 * seed deterministic in-memory volumes. */
	extraVolumes?: VolumeInit[];
	/** Disable auto-mount of `$cwd`. Tests use this to keep the volume
	 * surface deterministic. */
	skipCwdVolume?: boolean;
	/** Override the on-disk sqlite filename. Tests pass `:memory:`. */
	dbFilename?: string;
}

export interface HostState {
	cwd: string;
	db: AppDb;
	registry: ZenfsVolumeRegistry;
	/** Closes the sqlite handle. WS shutdown calls this once. */
	dispose(): Promise<void>;
}

export async function createHostState(opts: CreateHostStateOptions): Promise<HostState> {
	const db = openAppDb(opts.cwd, {
		filename: opts.dbFilename,
		inMemory: opts.dbFilename === ":memory:",
	});

	const registry = new ZenfsVolumeRegistry();
	const initialVolumes: VolumeInit[] = [];
	if (!opts.skipCwdVolume) {
		initialVolumes.push(createCwdVolumeInit({ cwd: opts.cwd }));
	}
	if (opts.extraVolumes) {
		initialVolumes.push(...opts.extraVolumes);
	}
	await registry.mountAll(initialVolumes);

	return {
		cwd: opts.cwd,
		db,
		registry,
		async dispose(): Promise<void> {
			try {
				db.$sqlite.close();
			} catch {
				// ignore: db may already be closed
			}
		},
	};
}
