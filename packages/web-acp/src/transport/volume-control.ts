/**
 * Main-thread client for the worker's volume-control channel.
 *
 * Wraps `Worker.postMessage` with a correlation-id scheme so callers
 * can `await` the mount/unmount reply. Only volume-related messages
 * are handled; everything else is ignored so the ACP wire on a
 * separate MessagePort keeps working.
 */
import type {
  VolumeControlReply,
  VolumeMountReply,
  VolumeUnmountReply,
} from '@/agent/volume-channel';
import type { VolumeInit } from '@/agent/volume-mount';

export interface VolumeControl {
  mount(init: VolumeInit): Promise<void>;
  unmount(mountName: string): Promise<void>;
  dispose(): void;
}

interface PendingEntry {
  resolve: () => void;
  reject: (err: Error) => void;
}

export function createVolumeControl(worker: Worker): VolumeControl {
  const pending = new Map<string, PendingEntry>();

  const listener = (event: MessageEvent<VolumeControlReply | unknown>) => {
    const reply = event.data as VolumeControlReply | undefined;
    if (!reply || typeof reply !== 'object' || !('type' in reply)) return;
    if (reply.type !== 'volumes/mount:reply' && reply.type !== 'volumes/unmount:reply') return;
    const entry = pending.get(reply.id);
    if (!entry) return;
    pending.delete(reply.id);
    if (reply.ok) {
      entry.resolve();
    } else {
      entry.reject(new Error(reply.error ?? 'volume control: worker rejected'));
    }
  };
  worker.addEventListener('message', listener);

  async function send(
    request:
      | { type: 'volumes/mount'; init: VolumeInit }
      | { type: 'volumes/unmount'; mountName: string }
  ): Promise<void> {
    const id = `vc-${crypto.randomUUID()}`;
    return new Promise<void>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      try {
        worker.postMessage({ id, ...request });
      } catch (err) {
        pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  return {
    async mount(init) {
      await send({ type: 'volumes/mount', init });
    },
    async unmount(mountName) {
      await send({ type: 'volumes/unmount', mountName });
    },
    dispose() {
      worker.removeEventListener('message', listener);
      for (const entry of pending.values()) entry.reject(new Error('volume-control disposed'));
      pending.clear();
    },
  };
}

// Helper re-exports so callers don't reach across the agent/transport boundary.
export type { VolumeInit, VolumeMountReply, VolumeUnmountReply };
