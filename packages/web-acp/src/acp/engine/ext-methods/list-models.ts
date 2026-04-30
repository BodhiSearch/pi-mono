import { apiFormatOfModel } from '@/agent/bodhi-provider';
import type { BodhiListModelsResponse } from '../../index';
import type { ExtMethodHost } from '../types';

export async function listModels(
  _params: unknown,
  host: ExtMethodHost
): Promise<BodhiListModelsResponse> {
  const models = await host.bodhi.getAvailableModels();
  host.setModels(models);
  return {
    models: models.map(m => ({ id: m.id, apiFormat: apiFormatOfModel(m) })),
  };
}
