/**
 * Process-wide host state for the WebSocket server.
 *
 * Holds shared infrastructure that survives across WebSocket
 * connections:
 *   - the sqlite `AppDb` (sessions + preferences),
 *   - a single `ZenfsVolumeRegistry` with the cwd `PassthroughFS`
 *     volume mounted at `/mnt/cwd`. Sharing matters: ZenFS keeps a
 *     process-global mount table, so each connection cannot bring up
 *     its own registry without colliding on `/mnt/cwd`.
 *
 * Per-connection wiring lives in `server.ts`: each accepted
 * WebSocket spins up its own `BodhiProvider` (auth tokens are
 * per-user) and assembles a fresh `AcpAdapterServices` bag that
 * points at the shared sessions / preferences / registry. Because
 * we use the agent's "advanced" surface (`@bodhiapp/web-acp-agent/
 * test-utils`), the registry can be shared by every connection.
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
