import type { SessionConfigOption } from '@agentclientprotocol/sdk';
import {
  FEATURE_DEFAULTS,
  type FeatureKey,
  type FeatureSnapshot,
} from '../storage/feature-defaults';
import {
  BODHI_FEATURE_BASH_ENABLED_CONFIG_ID,
  BODHI_FEATURE_CONFIG_CATEGORY,
  BODHI_FEATURE_FORCE_TOOL_CALL_CONFIG_ID,
} from '../wire';

interface FeatureConfigEntry {
  configId: string;
  featureKey: FeatureKey;
  name: string;
  description: string;
}

export const FEATURE_CONFIG_ENTRIES: readonly FeatureConfigEntry[] = [
  {
    configId: BODHI_FEATURE_BASH_ENABLED_CONFIG_ID,
    featureKey: 'bashEnabled',
    name: 'Bash tool',
    description: 'Register the bash shell tool with the LLM.',
  },
  {
    configId: BODHI_FEATURE_FORCE_TOOL_CALL_CONFIG_ID,
    featureKey: 'forceToolCall',
    name: 'Force tool call',
    description:
      'Pass tool_choice=required to pi-ai so a benign prompt deterministically triggers a tool call.',
  },
];

const FEATURE_KEY_BY_CONFIG_ID: Record<string, FeatureKey> = Object.fromEntries(
  FEATURE_CONFIG_ENTRIES.map(e => [e.configId, e.featureKey])
);

export function configIdToFeatureKey(configId: string): FeatureKey | null {
  return FEATURE_KEY_BY_CONFIG_ID[configId] ?? null;
}

const ON_OFF_SELECT_OPTIONS = [
  { value: 'on', name: 'On' },
  { value: 'off', name: 'Off' },
] as const;

export function buildFeatureConfigOptions(
  snapshot: FeatureSnapshot | typeof FEATURE_DEFAULTS
): SessionConfigOption[] {
  return FEATURE_CONFIG_ENTRIES.map(entry => ({
    type: 'select',
    id: entry.configId,
    name: entry.name,
    description: entry.description,
    category: BODHI_FEATURE_CONFIG_CATEGORY,
    currentValue: snapshot[entry.featureKey] ? 'on' : 'off',
    options: ON_OFF_SELECT_OPTIONS,
  }));
}
