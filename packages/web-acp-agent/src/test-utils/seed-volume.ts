import { fs, InMemory } from "@zenfs/core";
import type { VolumeInit } from "../agent/volume-registry";

export interface SeedSpec {
	mountName: string;
	description?: string;
	files: Record<string, string>;
}

/**
 * Builds a `VolumeInit` from an in-memory seed for unit tests. Mirrors
 * the host-side `toAgentVolumeInit` (which translates an FSA-handle or
 * seed payload from the main thread) but stays browser-free so the
 * agent package's tests can run under jsdom without `@zenfs/dom`.
 */
export function buildSeedInit(spec: SeedSpec): VolumeInit {
	const filesystem = InMemory.create({ label: spec.mountName });
	return {
		mountName: spec.mountName,
		...(spec.description ? { description: spec.description } : {}),
		fs: filesystem,
		initialize: async () => {
			const mountPath = `/mnt/${spec.mountName}`;
			for (const rel of Object.keys(spec.files).sort()) {
				const absolute = rel.startsWith("/") ? `${mountPath}${rel}` : `${mountPath}/${rel}`;
				const lastSlash = absolute.lastIndexOf("/");
				if (lastSlash > 0) {
					const parent = absolute.slice(0, lastSlash);
					try {
						await fs.promises.mkdir(parent, { recursive: true });
					} catch (err: unknown) {
						if (
							!err ||
							typeof err !== "object" ||
							!("code" in err) ||
							(err as { code?: string }).code !== "EEXIST"
						) {
							throw err;
						}
					}
				}
				await fs.promises.writeFile(absolute, spec.files[rel], { encoding: "utf8" });
			}
		},
	};
}
