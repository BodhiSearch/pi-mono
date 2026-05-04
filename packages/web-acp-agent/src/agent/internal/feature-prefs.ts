import {
  FEATURE_DEFAULTS,
  type FeatureSnapshot,
  isFeatureKey,
} from '../../storage/feature-defaults';
import type { PreferenceStore } from '../../storage/preference-store';

const PREFIX = 'feature:';

export async function readFeatureSnapshot(
  prefs: PreferenceStore,
  sessionId: string
): Promise<FeatureSnapshot> {
  const all = await prefs.list(sessionId);
  const overrides: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(all)) {
    if (!key.startsWith(PREFIX)) continue;
    if (typeof value !== 'boolean') continue;
    overrides[key.slice(PREFIX.length)] = value;
  }
  return { ...FEATURE_DEFAULTS, ...overrides };
}

export async function writeFeature(
  prefs: PreferenceStore,
  sessionId: string,
  key: string,
  value: boolean
): Promise<FeatureSnapshot> {
  if (!isFeatureKey(key)) throw new Error(`Unknown feature key '${key}'`);
  await prefs.set(sessionId, `${PREFIX}${key}`, value);
  return readFeatureSnapshot(prefs, sessionId);
}
