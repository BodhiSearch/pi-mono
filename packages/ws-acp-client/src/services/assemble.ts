/**
 * Service assembly for the WebSocket host.
 *
 * Two layers:
 *   1. `HostState` — shared across every WebSocket connection in the
 *      same process: the sqlite `AppDb` and the ZenFS `VolumeRegistry`
 *      (cwd PassthroughFS mount). Built once at process startup.
 *   2. `ConnectionServices` — one per accepted WebSocket: a fresh
 *      `BodhiProvider`, `InlineAgent`, and `streamOverrides` ref bag.
 *      The auth token from `authenticate(bodhi-token)` is per-
 *      connection, so the provider must not leak across users.
 */

import {
	type AcpAdapterServices,
	assembleServices,
	BodhiProvider,
	createInlineAgent,
	createStreamFn,
	type StreamOptionOverrides,
	type VolumeInit,
	ZenfsVolumeRegistry,
} from "@bodhiapp/web-acp-agent";
import {
	type AppDb,
	createSqliteFeatureStore,
	createSqliteMcpToggleStore,
	createSqliteSessionStore,
	openAppDb,
} from "../storage";
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

export interface ConnectionServices {
	services: AcpAdapterServices;
	provider: BodhiProvider;
}

export function createConnectionServices(host: HostState): ConnectionServices {
	const provider = new BodhiProvider();
	const streamOverrides: { current: StreamOptionOverrides } = { current: {} };
	const inline = createInlineAgent(
		createStreamFn(provider, () => {
			const snapshot = streamOverrides.current;
			streamOverrides.current = {};
			return snapshot;
		}),
	);

	const services = assembleServices({
		inline,
		bodhi: provider,
		store: createSqliteSessionStore(host.db),
		registry: host.registry,
		features: createSqliteFeatureStore(host.db),
		mcpToggles: createSqliteMcpToggleStore(host.db),
		streamOverrides,
	});

	return { services, provider };
}
