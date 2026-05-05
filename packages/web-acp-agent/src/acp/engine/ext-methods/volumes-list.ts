import type { BodhiVolumesListResponse } from '../../../wire';
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
      ...(v.tags.length > 0 ? { tags: [...v.tags] } : {}),
    })),
  };
}
