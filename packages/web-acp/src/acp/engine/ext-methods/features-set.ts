import { isFeatureKey } from '@/features/feature-store';
import {
  BODHI_FEATURES_SET_METHOD,
  type BodhiFeaturesSetRequest,
  type BodhiFeaturesSetResponse,
} from '../../index';
import type { ExtMethodHost } from '../types';

export async function featuresSet(
  params: unknown,
  host: ExtMethodHost
): Promise<BodhiFeaturesSetResponse> {
  const req = params as BodhiFeaturesSetRequest;
  if (
    !req ||
    typeof req.sessionId !== 'string' ||
    typeof req.key !== 'string' ||
    typeof req.value !== 'boolean'
  ) {
    throw new Error(
      `${BODHI_FEATURES_SET_METHOD}: params must be { sessionId, key, value: boolean }`
    );
  }
  if (!isFeatureKey(req.key)) {
    throw new Error(`${BODHI_FEATURES_SET_METHOD}: unknown feature '${req.key}'`);
  }
  if (req.key === 'forceToolCall' && !host.isDev) {
    const err = new Error('forceToolCall is DEV-only');
    (err as unknown as { code: number }).code = -32004;
    throw err;
  }
  if (!host.features) {
    throw new Error(`${BODHI_FEATURES_SET_METHOD}: feature store unavailable`);
  }
  const next = await host.features.set(req.sessionId, req.key, req.value);
  return { features: { ...next } };
}
