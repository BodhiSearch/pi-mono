import { Checkbox } from '@/components/ui/checkbox';
import type { FeatureBag } from '@/acp/feature-keys';

export interface FeaturePanelProps {
  features: FeatureBag;
  onChange: (key: string, value: boolean) => void | Promise<void>;
  disabled?: boolean;
}

interface FeatureMeta {
  key: string;
  label: string;
  description: string;
  devOnly?: boolean;
}

const IS_DEV = typeof __WEB_ACP_DEV__ === 'boolean' ? __WEB_ACP_DEV__ : false;

const FEATURE_META: FeatureMeta[] = [
  {
    key: 'bashEnabled',
    label: 'Bash tool',
    description: 'Let the agent run shell scripts against mounted volumes.',
  },
  {
    key: 'forceToolCall',
    label: 'Force tool call (DEV)',
    description: 'Tell the model it must call a tool on the next turn.',
    devOnly: true,
  },
];

/**
 * Renders every known feature toggle as a single row keyed by feature
 * name. Toggles write through to the worker via the parent-provided
 * `onChange`. DEV-only features are rendered collapsed outside DEV
 * builds so production users can't see them at all.
 */
export default function FeaturePanel({ features, onChange, disabled }: FeaturePanelProps) {
  const visible = FEATURE_META.filter(meta => !meta.devOnly || IS_DEV);
  const enabledCount = visible.filter(meta => resolve(features, meta.key)).length;
  return (
    <section
      data-testid="features-panel"
      data-test-state={String(enabledCount)}
      className="border-b bg-gray-50"
    >
      <header className="flex items-center justify-between px-3 py-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500">Features</h2>
      </header>
      <ul className="flex flex-col pb-2">
        {visible.map(meta => {
          const current = resolve(features, meta.key);
          return (
            <li
              key={meta.key}
              data-testid={`feature-row-${meta.key}`}
              data-test-state={current ? 'on' : 'off'}
              className="flex items-start gap-2 px-3 py-1.5 text-xs"
            >
              <Checkbox
                id={`feature-${meta.key}`}
                data-testid={`feature-toggle-${meta.key}`}
                checked={current}
                disabled={disabled}
                onCheckedChange={checked => void onChange(meta.key, Boolean(checked))}
              />
              <label
                htmlFor={`feature-${meta.key}`}
                className="flex flex-col gap-0.5 cursor-pointer select-none"
              >
                <span className="font-medium text-gray-700">{meta.label}</span>
                <span className="text-gray-500">{meta.description}</span>
              </label>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function resolve(features: FeatureBag, key: string): boolean {
  if (key in features) return Boolean(features[key]);
  return false;
}
