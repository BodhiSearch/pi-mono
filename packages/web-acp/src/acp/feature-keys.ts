import {
  BODHI_FEATURE_BASH_ENABLED_CONFIG_ID,
  BODHI_FEATURE_FORCE_TOOL_CALL_CONFIG_ID,
} from '@/acp/index';

export type FeatureBag = Record<string, boolean>;

const FEATURE_PAIRS = [
  ['bashEnabled', BODHI_FEATURE_BASH_ENABLED_CONFIG_ID],
  ['forceToolCall', BODHI_FEATURE_FORCE_TOOL_CALL_CONFIG_ID],
] as const;

export const FEATURE_KEY_BY_CONFIG_ID: Readonly<Record<string, string>> = Object.fromEntries(
  FEATURE_PAIRS.map(([key, configId]) => [configId, key])
);

export const FEATURE_KEY_TO_CONFIG_ID: Readonly<Record<string, string>> =
  Object.fromEntries(FEATURE_PAIRS);
