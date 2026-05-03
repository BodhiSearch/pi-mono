# Features — host-side hook + UI panel

**Source of truth:** `packages/web-acp/src/hooks/useAcpFeatures.ts`,
`packages/web-acp/src/components/features/FeaturePanel.tsx`.

## Purpose

Browser-host-side surface for the per-session feature
toggles. Reads the bag from the agent via
`_bodhi/features/list`, mutates via `_bodhi/features/set`,
and renders a per-flag toggle UI gated on DEV mode for
DEV-only features.

The interface, defaults, and the agent's wire handlers all
live in [`../web-acp-agent/features.md`](../web-acp-agent/features.md).
The host's only job is to surface the slice in React and
filter the UI on `__WEB_ACP_DEV__`.

## `useAcpFeatures` — `hooks/useAcpFeatures.ts:24`

Slice hook owning `{ features, featureDefaults }` state.
Composes into the `useAcp` facade alongside the other slice
hooks; see [`hooks.md`](./hooks.md).

```ts
function useAcpFeatures(
    setError: (msg: string | null) => void,
): UseAcpFeaturesResult;

interface UseAcpFeaturesResult {
    features: BodhiFeatureBag;
    featureDefaults: BodhiFeatureBag;
    refreshFeatures: (sessionId: string) => Promise<void>;
    setFeature: (key: string, value: boolean) => Promise<void>;
    clearFeatures: () => void;
}
```

| Method | Behaviour |
| --- | --- |
| `refreshFeatures(sessionId)` | Awaits `runtime.initialize`, calls `client.listFeatures(sessionId)` (`_bodhi/features/list`), sets `features` + `featureDefaults`. Errors are logged but don't propagate to `setError` because feature-load failures shouldn't block the rest of session boot. |
| `setFeature(key, value)` | Reads the active session via `getSession()` from the runtime singleton; bails silently if no session yet. Calls `client.setFeature(sessionId, key, value)`; on success, replaces `features` from the response. On failure, surfaces via `setError` + `await refreshFeatures(sessionId)` to fall back to the worker's truth. |
| `clearFeatures()` | Resets `features` to `{}`. `featureDefaults` is preserved. Called from `useAcpSession.clearMessages` so the picker shows defaults the moment the user starts a fresh session. |

The hook does **not** watch session id changes itself —
`useAcpSession` calls `refreshFeatures(sessionId)` whenever
the active session changes (post-`session/new` and
post-`session/load`). This keeps the slice independent of
the session machinery and lets the facade decide ordering.

## `FeaturePanel` — `components/features/FeaturePanel.tsx`

Renders every known feature toggle as a single row keyed by
feature name.

Props:

```ts
interface FeaturePanelProps {
    features: BodhiFeatureBag;
    defaults: BodhiFeatureBag;
    onChange: (key: string, value: boolean) => void | Promise<void>;
    disabled?: boolean;
}
```

`FEATURE_META: FeatureMeta[]` (`:20`) is the host-side
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

This is **decoupled** from the agent's `FEATURE_DEFAULTS` —
the agent owns runtime semantics; the host owns user-facing
labels + DEV gating. Adding a new flag means:

1. Extend `FeatureDefaults` in the agent package (see
   [`../web-acp-agent/features.md`](../web-acp-agent/features.md)).
2. Add a `FEATURE_META` entry here with the user-facing
   label + description.

### DEV gate — `:18`

```ts
const IS_DEV = typeof __WEB_ACP_DEV__ === 'boolean'
    ? __WEB_ACP_DEV__
    : false;

// inside the component:
const visible = FEATURE_META.filter(meta => !meta.devOnly || IS_DEV);
```

Production builds dead-code-eliminate the `forceToolCall`
row from the rendered output. The agent enforces DEV
membership independently via
`AcpAgentAdapterOptions.isDev` (see
[`../web-acp-agent/features.md`](../web-acp-agent/features.md)
§ DEV gating) — even if a malicious client sent
`_bodhi/features/set forceToolCall=true` to a production
agent, the agent rejects it with JSON-RPC error
`-32004`.

### Rendering

- `data-testid="features-panel"` on the `<section>`.
- Per-row: `data-testid="feature-row-<key>"`,
  `data-test-state="enabled | disabled"`.
- Each row uses the `Checkbox` shadcn component (radix-ui
  underneath); on flip, calls `onChange(meta.key, nextValue)`.
- Header reports `<enabledCount>/<visible.length>`.
- `disabled` prop disables all checkboxes (used by the
  parent during `session/load` replay).

`resolve(features, defaults, key)` is a small helper at the
file's bottom: returns `features[key] ?? defaults[key] ??
false`. Reading `features` first means user-set overrides
beat defaults; falling through to `defaults` then `false`
covers fresh sessions and unknown keys.

## Wire shape

The host calls into the agent via:

| Method | Wire method | Direction |
| --- | --- | --- |
| `client.listFeatures(sessionId)` | `_bodhi/features/list` | request |
| `client.setFeature(sessionId, key, value)` | `_bodhi/features/set` | request |

Both shapes are documented at
[`../web-acp-agent/features.md`](../web-acp-agent/features.md).

## Persistence boundary

The host doesn't persist features locally. The Dexie
`features` table at [`storage-dexie.md`](./storage-dexie.md)
is the source of truth and the agent's `_bodhi/features/list`
reads from it. The host hook only owns *cached UI state* —
on tab reload the cache is empty until the next
`refreshFeatures(sessionId)` call lands.

## Cross-references

- Agent-side interface, defaults, ext-method handlers:
  [`../web-acp-agent/features.md`](../web-acp-agent/features.md).
- Hook composition + `refreshFeatures` invocation site:
  [`hooks.md`](./hooks.md) (`useAcpFeatures`,
  `useAcpSession`).
- Persistence row:
  [`storage-dexie.md`](./storage-dexie.md) (`createFeatureStore`).
- DEV gate paired with the agent-side `isDev`:
  [`acp.md`](./acp.md) §
  startup-sequence cross-link.
