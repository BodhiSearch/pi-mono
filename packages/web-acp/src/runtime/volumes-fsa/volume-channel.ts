/**
 * Sidechannel for FSA mount/unmount postMessages — handles can't ride
 * the ACP NDJSON wire, so worker bootstrap forwards them directly to
 * the host-owned `VolumeRegistry`.
 */
import type { VolumeRegistry } from '@bodhiapp/web-acp-agent';
import { toAgentVolumeInit } from './backends';
import type { HostVolumeInit } from './types';

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
  registry: VolumeRegistry
): () => void {
  const listener = async (event: MessageEvent<unknown>): Promise<void> => {
    const msg = event.data as VolumeControlRequest | undefined;
    if (!msg || typeof msg !== 'object' || !('type' in msg)) return;
    if (msg.type === 'volumes/mount') {
      try {
        const agentInit = await toAgentVolumeInit(msg.init);
        await registry.mount(agentInit);
        scope.postMessage({
          type: 'volumes/mount:reply',
          id: msg.id,
          ok: true,
          mountName: msg.init.mountName,
        } satisfies VolumeMountReply);
      } catch (err) {
        scope.postMessage({
          type: 'volumes/mount:reply',
          id: msg.id,
          ok: false,
          mountName: msg.init.mountName,
          error: errorMessage(err),
        } satisfies VolumeMountReply);
      }
      return;
    }
    if (msg.type === 'volumes/unmount') {
      try {
        await registry.unmount(msg.mountName);
        scope.postMessage({
          type: 'volumes/unmount:reply',
          id: msg.id,
          ok: true,
          mountName: msg.mountName,
        } satisfies VolumeUnmountReply);
      } catch (err) {
        scope.postMessage({
          type: 'volumes/unmount:reply',
          id: msg.id,
          ok: false,
          mountName: msg.mountName,
          error: errorMessage(err),
        } satisfies VolumeUnmountReply);
      }
      return;
    }
  };
  scope.addEventListener('message', listener as unknown as EventListener);
  return () => scope.removeEventListener('message', listener as unknown as EventListener);
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
