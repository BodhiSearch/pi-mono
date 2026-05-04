export interface FeatureDefaults {
  bashEnabled: boolean;
  forceToolCall: boolean;
}

export const FEATURE_DEFAULTS: FeatureDefaults = {
  bashEnabled: true,
  forceToolCall: false,
};

export type FeatureKey = keyof FeatureDefaults;

export function isFeatureKey(key: string): key is FeatureKey {
  return key in FEATURE_DEFAULTS;
}

export interface FeatureSnapshot extends FeatureDefaults {
  [key: string]: boolean;
}
