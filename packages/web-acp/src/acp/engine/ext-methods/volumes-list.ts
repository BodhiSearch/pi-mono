import type { BodhiVolumesListResponse } from '../../index';
import type { ExtMethodHost } from '../types';

export async function volumesList(
  _params: unknown,
  host: ExtMethodHost
): Promise<BodhiVolumesListResponse> {
  const volumes = host.registry?.list() ?? [];
  return {
    volumes: volumes.map(v => ({
      mountName: v.mountName,
      ...(v.description ? { description: v.description } : {}),
    })),
  };
}
