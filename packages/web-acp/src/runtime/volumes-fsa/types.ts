export interface VolumeSeed {
  name: string;
  description?: string;
  files: Record<string, string>;
  tags?: readonly string[];
}

/**
 * Browser-host volume init: the shape the main thread serialises and
 * sends to the worker. Carries either a `FileSystemDirectoryHandle`
 * (real FSA mount) or a dev/test `VolumeSeed`. The worker bootstrap
 * converts this into the agent package's transport-agnostic
 * `VolumeInit` (which carries a constructed `FileSystem` instead).
 *
 * `FileSystemDirectoryHandle` is structured-cloneable but NOT
 * JSON-serialisable, so this travels over a raw `postMessage`
 * sidechannel — never on the ACP ndJson wire.
 */
export interface HostVolumeInit {
  mountName: string;
  description?: string;
  handle?: FileSystemDirectoryHandle;
  seed?: VolumeSeed;
  tags?: readonly string[];
}
