# Features — host-side memo + UI panel

**Source of truth:**
`packages/web-acp/src/hooks/useAcp.ts:88-121` (inline
features memo + `setFeature`),
`packages/web-acp/src/acp/feature-keys.ts`,
`packages/web-acp/src/acp/panels-reducer.ts:37` (`config-options-init` case),
`packages/web-acp/src/components/features/FeaturePanel.tsx`.

## Purpose

Browser-host-side surface for the per-session feature
toggles. Source of truth on the wire is now the standard ACP
`SessionConfigOption[]` payload, not a Bodhi-namespaced
list. The hook layer does **no** wire calls of its own — it
selects from `panelsState.configOptions` (hydrated by
`'config-options-init'` from
`NewSessionResponse.configOptions` /
`LoadSessionResponse.configOptions`, refreshed by the
agent's `config_option_update` notification on the same
slice) and writes back via
`Agent.setSessionConfigOption`.

The interface, defaults, the agent's wire constants
(`BODHI_FEATURE_BASH_ENABLED_CONFIG_ID`,
`BODHI_FEATURE_FORCE_TOOL_CALL_CONFIG_ID`,
`BODHI_FEATURE_CONFIG_CATEGORY`), the `feature-config.ts`
catalog, and the `setSessionConfigOption` handler all live
in [`../web-acp-agent/features.md`](../web-acp-agent/features.md).
The host's only job is to surface the slice in React and
filter the UI on `__WEB_ACP_DEV__`.

There is **no** dedicated `useAcpFeatures` hook anymore —
the inline `features` memo and `setFeature` callback in
`useAcp.ts` absorbed it.

## `acp/feature-keys.ts` — wire ↔ UI key mapping

Tiny module that owns the bidirectional translation between
the agent's wire `configId` strings (e.g.
`_bodhi/features/bashEnabled`) and the host UI's short
`FeatureBag` keys (e.g. `bashEnabled`).

```ts
export type FeatureBag = Record<string, boolean>;

const FEATURE_PAIRS = [
  ['bashEnabled', BODHI_FEATURE_BASH_ENABLED_CONFIG_ID],
  ['forceToolCall', BODHI_FEATURE_FORCE_TOOL_CALL_CONFIG_ID],
] as const;

export const FEATURE_KEY_BY_CONFIG_ID; // configId -> short key
export const FEATURE_KEY_TO_CONFIG_ID; // short key -> configId
```

Adding a new flag requires:

1. Extend `FeatureDefaults` + `FEATURE_CONFIG_ENTRIES` in
   the agent package (see
   [`../web-acp-agent/features.md`](../web-acp-agent/features.md)).
2. Add a `FEATURE_PAIRS` entry here using the matching
   wire-constant export from `@/acp/index`.
3. Add a `FEATURE_META` row in
   `components/features/FeaturePanel.tsx` (label +
   description; `devOnly` if applicable).

## `panelsState.configOptions` — the slice

`panelsReducer` (`acp/panels-reducer.ts:32`) is the only
state owner for `configOptions` on the host. It handles three
incoming actions that touch the slice:

| Action | Source | Behaviour |
| --- | --- | --- |
| `'config-options-init'` | `useAcpSession.ensureSession` / `loadSession` after `NewSessionResponse` / `LoadSessionResponse` | Replaces `configOptions` wholesale with the agent's snapshot. |
| `'session-update'` with `update.sessionUpdate === 'config_option_update'` | Agent's notification on `Agent.setSessionConfigOption` | Replaces the slice with the agent's authoritative list. Empty list collapses to the frozen `EMPTY_CONFIG_OPTIONS` sentinel for `===`-bailout. |
| `'reset'` | `useAcpSession.clearMessages` | **Preserves `configOptions`.** Only `availableCommands` resets. |

The reset preservation is deliberate: the agent re-emits a
fresh `configOptions` snapshot on the next `session/new`,
so resetting it locally would just cause a flash of empty
toggles. Same reasoning as `mcpStates` preservation (see
[`acp.md`](./acp.md) § panelsReducer).

## Inline `useAcp` slice — `hooks/useAcp.ts:88–121`

Two pieces, both inlined into the facade because they're
trivially memoisable and don't justify a hook of their own:

### `features` memo (lines `:88-101`)

```ts
const features = useMemo<FeatureBag>(() => {
  const out: FeatureBag = {};
  for (const opt of panelsState.configOptions) {
    const featureKey = FEATURE_KEY_BY_CONFIG_ID[opt.id];
    if (!featureKey) continue;
    if (opt.type === 'select') {
      out[featureKey] = opt.currentValue === 'on';
    } else if (opt.type === 'boolean') {
      out[featureKey] = Boolean(opt.currentValue);
    }
  }
  return out;
}, [panelsState.configOptions]);
```

Translation rules:

- The agent emits `select` config options with stable
  `'on' | 'off'` literal values; the memo accepts both
  `'on' === 'on'` and the legacy unstable `boolean` shape so
  a stale agent build doesn't break the toggle UI mid-roll.
- Unknown configIds are silently skipped — only the keys in
  `FEATURE_KEY_BY_CONFIG_ID` produce a `FeatureBag` entry,
  so an agent that adds a new feature config the host
  doesn't know about doesn't crash the panel.
- Keys absent from the snapshot map to `undefined` in
  `FeatureBag`, which `FeaturePanel.resolve` reads as
  `false`.

### `setFeature` callback (lines `:103-121`)

```ts
const setFeature = useCallback(
  async (key: string, value: boolean) => {
    const sessionId = getSession();
    if (!sessionId) return;
    const configId = FEATURE_KEY_TO_CONFIG_ID[key];
    if (!configId) return;
    try {
      await ensureRuntime().client.setSessionConfigOption(
        sessionId,
        configId,
        value ? 'on' : 'off'
      );
    } catch (err) {
      console.error('setSessionConfigOption failed:', err);
      setError(getErrorMessage(err, 'Failed to toggle feature'));
    }
  },
  [setError]
);
```

Behaviour:

1. Reads the live session via `getSession()` from the
   runtime singleton; **silently bails when no session**
   (the panel can render before the auto-`ensureSession`
   effect lands; we don't want to throw).
2. Translates the UI's short key to the wire configId via
   `FEATURE_KEY_TO_CONFIG_ID`; bails on unknown keys
   (defensive).
3. Calls `client.setSessionConfigOption(sessionId, configId,
   value ? 'on' : 'off')` — wire value is the literal
   `'on'` / `'off'`, matching the agent's
   `ON_OFF_SELECT_OPTIONS`.
4. Errors flow into `setError` (toast layer) + a
   `console.error`. **Does not** call `refreshFeatures` —
   the agent will re-emit `config_option_update` either way
   (success path or failure-with-revert), so we trust the
   reducer to converge.

The facade returns the memo and the callback as `features`
+ `setFeature` (lines `:180-181`); both flow into
`<FeaturePanel features={features} onChange={setFeature}
disabled={isLoadingSession} />` in
`components/chat/ChatDemo.tsx`.

## `FeaturePanel` — `components/features/FeaturePanel.tsx`

Renders every known feature toggle as a single row keyed by
feature short key.

Props (`:4-8`):

```ts
interface FeaturePanelProps {
  features: FeatureBag;
  onChange: (key: string, value: boolean) => void | Promise<void>;
  disabled?: boolean;
}
```

The legacy `defaults` prop and "default" badge column are
gone — the agent's defaults are now baked into the
`SessionConfigOption[]` snapshot it sends, so the host
doesn't need a parallel "default" view.

`FEATURE_META: FeatureMeta[]` (`:19-31`) is the host-side
catalog of presentation metadata for each flag:

```ts
[
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
]
```

This is **decoupled** from the agent's `FEATURE_DEFAULTS` /
`FEATURE_CONFIG_ENTRIES` — the agent owns wire semantics
and runtime defaults; the host owns user-facing labels +
DEV gating. It is **also** decoupled from `feature-keys.ts`
in the sense that it doesn't import either map; the keys
must just match by string.

### DEV gate — `:17, :40`

```ts
const IS_DEV = typeof __WEB_ACP_DEV__ === 'boolean'
  ? __WEB_ACP_DEV__
  : false;

// inside the component:
const visible = FEATURE_META.filter(meta => !meta.devOnly || IS_DEV);
```

Production builds dead-code-eliminate the `forceToolCall`
row from the rendered output. The agent enforces DEV
membership independently via `AcpAgentAdapterOptions.isDev`
inside `handleSetSessionConfigOption` — even if a malicious
client sent `setSessionConfigOption forceToolCall=on` to a
production agent, the agent rejects it with JSON-RPC error
`-32004` (see
[`../web-acp-agent/features.md`](../web-acp-agent/features.md)
§ DEV gating).

### Rendering (`:42-80`)

- `data-testid="features-panel"` on the `<section>`,
  `data-test-state="<enabledCount>"` for the e2e visibility
  probe.
- Per-row: `data-testid="feature-row-<key>"`,
  `data-test-state="on" | "off"`,
  `data-testid="feature-toggle-<key>"` on the checkbox.
- Each row uses the `Checkbox` shadcn component (radix-ui
  underneath); on flip, calls `onChange(meta.key,
  Boolean(checked))` — the parent's `setFeature`.
- Header reports the count by stamping
  `String(enabledCount)` into `data-test-state`; the
  visible markup just shows the section title.
- `disabled` prop disables all checkboxes (used by the
  parent during `session/load` replay to lock the panel
  while the worker rehydrates).

`resolve(features, key)` (`:83-86`) is a small helper at
the file's bottom: returns `features[key] ?? false`. The
defaults arm is gone because the snapshot already carries
the effective value.

## Wire shape

The host calls into the agent via the SDK's standard ACP
methods now — no Bodhi-namespaced wrapper:

| Host call | Wire method | Direction |
| --- | --- | --- |
| `client.setSessionConfigOption(sessionId, configId, value)` | `session/setSessionConfigOption` | request → response |
| `client.onSessionUpdate(notif)` with `notif.update.sessionUpdate === 'config_option_update'` | `session/update` | notification (agent → host) |

`NewSessionResponse.configOptions` and
`LoadSessionResponse.configOptions` carry the snapshot at
session creation / reload; `'config_option_update'`
notifications stream subsequent changes. All shapes are
documented at
[`../web-acp-agent/features.md`](../web-acp-agent/features.md)
§ Wire constants and § Handler.

## Persistence boundary

The host doesn't persist features locally. The Dexie
`features` table at [`storage-dexie.md`](./storage-dexie.md)
is the source of truth and the agent reads from it on
session creation / reload. The host's reducer slice is
authoritative-from-the-agent: on tab reload the
`configOptions` slice starts at `EMPTY_CONFIG_OPTIONS`
until the next `NewSessionResponse` / `LoadSessionResponse`
hydrates it.

## Cross-references

- Agent-side wire constants, `feature-config.ts` registry,
  `setSessionConfigOption` handler, `config_option_update`
  emitter, defaults, DEV gating:
  [`../web-acp-agent/features.md`](../web-acp-agent/features.md).
- Reducer details (`'config-options-init'`,
  `config_option_update` arm, frozen-empty sentinels):
  [`acp.md`](./acp.md) § panelsReducer.
- Hook composition + facade plumbing:
  [`hooks.md`](./hooks.md) § `useAcp` facade.
- Persistence row:
  [`storage-dexie.md`](./storage-dexie.md) (`createFeatureStore`).
- DEV gate paired with the agent-side `isDev`:
  [`../web-acp-agent/startup-sequence.md`](../web-acp-agent/startup-sequence.md)
  § Phase 1.
