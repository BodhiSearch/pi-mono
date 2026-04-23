/**
 * Worker-side control channel for runtime volume mount/unmount.
 *
 * FSA `FileSystemDirectoryHandle`s are structured-cloneable but not
 * JSON-serialisable, so they can't ride the ACP wire (which is
 * ndJson over a MessageChannel). We keep a dedicated raw-`postMessage`
 * side channel on the worker global scope for volume lifecycle events
 * that carry handles. The main thread sends `volumes/mount` /
 * `volumes/unmount`; the worker replies on the same channel with a
 * correlation id so the caller can await the result.
 */
import type { VolumeInit, VolumeRegistry } from './volume-mount';

export interface VolumeMountRequest {
  type: 'volumes/mount';
  id: string;
  init: VolumeInit;
}

export interface VolumeUnmountRequest {
  type: 'volumes/unmount';
  id: string;
  mountName: string;
}

export interface VolumeMountReply {
  type: 'volumes/mount:reply';
  id: string;
  ok: boolean;
  mountName: string;
  error?: string;
}

export interface VolumeUnmountReply {
  type: 'volumes/unmount:reply';
  id: string;
  ok: boolean;
  mountName: string;
  error?: string;
}

export type VolumeControlRequest = VolumeMountRequest | VolumeUnmountRequest;
export type VolumeControlReply = VolumeMountReply | VolumeUnmountReply;

/**
 * Wire a `VolumeRegistry` to the worker's `message` events. Ignores
 * anything that isn't a volume-control message so it coexists with the
 * agent init handshake on the same worker scope.
 */
export function attachVolumeChannel(
  scope: DedicatedWorkerGlobalScope,
  registry: VolumeRegistry
): () => void {
  const listener = async (event: MessageEvent<unknown>): Promise<void> => {
    const msg = event.data as VolumeControlRequest | undefined;
    if (!msg || typeof msg !== 'object' || !('type' in msg)) return;
    if (msg.type === 'volumes/mount') {
      try {
        await registry.mount(msg.init);
        scope.postMessage(<VolumeMountReply>{
          type: 'volumes/mount:reply',
          id: msg.id,
          ok: true,
          mountName: msg.init.mountName,
        });
      } catch (err) {
        scope.postMessage(<VolumeMountReply>{
          type: 'volumes/mount:reply',
          id: msg.id,
          ok: false,
          mountName: msg.init.mountName,
          error: errorMessage(err),
        });
      }
      return;
    }
    if (msg.type === 'volumes/unmount') {
      try {
        await registry.unmount(msg.mountName);
        scope.postMessage(<VolumeUnmountReply>{
          type: 'volumes/unmount:reply',
          id: msg.id,
          ok: true,
          mountName: msg.mountName,
        });
      } catch (err) {
        scope.postMessage(<VolumeUnmountReply>{
          type: 'volumes/unmount:reply',
          id: msg.id,
          ok: false,
          mountName: msg.mountName,
          error: errorMessage(err),
        });
      }
      return;
    }
  };
  scope.addEventListener('message', listener as EventListener);
  return () => scope.removeEventListener('message', listener as EventListener);
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
