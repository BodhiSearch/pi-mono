/**
 * `/feature` command — read/write per-session feature flags.
 *
 * Subcommands:
 *   - `list` (default): fetch the agent's current bag + defaults via
 *     `_bodhi/features/list` and render a small table.
 *   - `<key> on|off`: shortcut for the most common pattern; calls
 *     `_bodhi/features/set` with `(sessionId, key, value)`.
 *   - `set <key> <on|off>`: explicit form for the rare keys whose
 *     name collides with `list`/`help` (none today, but kept for
 *     forward compat).
 *
 * `forceToolCall` is always exposed to the user (per the parity
 * plan) so they can opt-in even outside of a DEV build. It is only
 * effective on the agent side when `isDev=true`; toggling it in a
 * non-DEV build is a no-op.
 */

import type { SlashCommand } from '../shell/registry';
import type { AppContext } from '../shell/context';

const KNOWN_FEATURE_KEYS = ['bashEnabled', 'forceToolCall'] as const;
type KnownFeatureKey = (typeof KNOWN_FEATURE_KEYS)[number];

export const featureCommand: SlashCommand = {
  name: 'feature',
  description: 'Inspect and toggle per-session feature flags (bash, forceToolCall).',
  usage: '/feature [list|<key> on|off|set <key> <on|off>]',
  async handler(ctx, args) {
    const [first, ...rest] = args;
    const action = (first ?? 'list').toLowerCase();
    if (action === 'list' || action === 'ls') {
      return renderList(ctx);
    }
    if (action === 'set') {
      const [key, value] = rest;
      return setFeature(ctx, key, value);
    }
    return setFeature(ctx, first, rest[0]);
  },
};

async function renderList(ctx: AppContext): Promise<void> {
  if (!ctx.sessionId) {
    ctx.renderer.emit({
      kind: 'info',
      text: 'No active session. Send a prompt first to spin one up.',
    });
    return;
  }
  let snapshot;
  try {
    snapshot = await ctx.client.listFeatures(ctx.sessionId);
  } catch (err) {
    ctx.renderer.emit({
      kind: 'error',
      text: `Failed to list features: ${err instanceof Error ? err.message : String(err)}`,
    });
    return;
  }
  const merged: Record<string, boolean> = { ...snapshot.defaults, ...snapshot.features };
  const lines = [`Features (session ${ctx.sessionId}):`];
  for (const key of Object.keys(merged).sort()) {
    const value = merged[key] ? 'on' : 'off';
    const overridden = key in snapshot.features;
    const overrideSuffix = overridden ? '' : ' (default)';
    const devOnlySuffix = isDevOnlyFeature(key) && !ctx.isDev ? ' [no-op outside DEV mode]' : '';
    lines.push(`  ${key.padEnd(20)} ${value}${overrideSuffix}${devOnlySuffix}`);
  }
  ctx.renderer.emit({ kind: 'info', text: lines.join('\n') });
}

const DEV_ONLY_FEATURES = new Set<string>(['forceToolCall']);

function isDevOnlyFeature(key: string): boolean {
  return DEV_ONLY_FEATURES.has(key);
}

async function setFeature(
  ctx: AppContext,
  rawKey: string | undefined,
  rawValue: string | undefined
): Promise<void> {
  if (!rawKey || !rawValue) {
    ctx.renderer.emit({
      kind: 'error',
      text: 'Usage: /feature <key> on|off (try /feature list to see keys).',
    });
    return;
  }
  if (!ctx.sessionId) {
    ctx.renderer.emit({
      kind: 'error',
      text: 'No active session. Send a prompt first to spin one up.',
    });
    return;
  }
  const key = rawKey;
  const value = parseBoolish(rawValue);
  if (value === null) {
    ctx.renderer.emit({
      kind: 'error',
      text: `Cannot parse '${rawValue}' as on/off. Use on|off|true|false|1|0.`,
    });
    return;
  }
  if (!isKnownFeatureKey(key)) {
    ctx.renderer.emit({
      kind: 'system',
      text: `Note: '${key}' is not a known feature; setting it anyway. Known keys: ${KNOWN_FEATURE_KEYS.join(', ')}.`,
    });
  }
  try {
    const result = await ctx.client.setFeature(ctx.sessionId, key, value);
    const effective = result.features[key];
    const noopHint = isDevOnlyFeature(key) && !ctx.isDev ? ' (no-op: requires DEV mode)' : '';
    ctx.renderer.emit({
      kind: 'info',
      text: `Feature '${key}' set to ${effective ? 'on' : 'off'}${noopHint}.`,
    });
  } catch (err) {
    ctx.renderer.emit({
      kind: 'error',
      text: `Failed to set feature: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

function parseBoolish(input: string): boolean | null {
  switch (input.toLowerCase()) {
    case 'on':
    case 'true':
    case '1':
    case 'yes':
    case 'y':
      return true;
    case 'off':
    case 'false':
    case '0':
    case 'no':
    case 'n':
      return false;
    default:
      return null;
  }
}

function isKnownFeatureKey(key: string): key is KnownFeatureKey {
  return (KNOWN_FEATURE_KEYS as readonly string[]).includes(key);
}
