/**
 * Worker-side control channel for runtime volume mount/unmount. FSA
 * `FileSystemDirectoryHandle`s are structured-cloneable but not
 * JSON-serialisable, so they can't ride the ACP NDJSON wire — we use
 * a dedicated raw-`postMessage` sidechannel on the worker global scope.
 *
 * The target is a `MountTarget` (matches `StartAgentHandle.mount`/
 * `unmount`); the worker bootstrap converts host-shaped `HostVolumeInit`
 * into the agent's transport-agnostic `VolumeInit` via
 * `toAgentVolumeInit` before forwarding.
 */
import { toAgentVolumeInit } from './backends';
import type { HostVolumeInit } from './types';

export interface MountTarget {
  mount(init: import('@bodhiapp/web-acp-agent').VolumeInit): Promise<void>;
  unmount(mountName: string): Promise<void>;
}

export interface VolumeMountRequest {
  type: 'volumes/mount';
  id: string;
  init: HostVolumeInit;
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

export function attachVolumeChannel(
  scope: DedicatedWorkerGlobalScope,
  target: MountTarget
): () => void {
  const listener = async (event: MessageEvent<unknown>): Promise<void> => {
    const msg = event.data as VolumeControlRequest | undefined;
    if (!msg || typeof msg !== 'object' || !('type' in msg)) return;
    if (msg.type === 'volumes/mount') {
      try {
        const agentInit = await toAgentVolumeInit(msg.init);
        await target.mount(agentInit);
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
        await target.unmount(msg.mountName);
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
