# features

**Source of truth:**
`packages/web-acp/src/features/feature-store.ts`,
`packages/web-acp/src/agent/session-store.ts` (Dexie v2 `features`
table),
`packages/web-acp/src/components/features/FeaturePanel.tsx`.

**Parent:** [`./index.md`](./index.md)

## Purpose

M2 introduces a small, per-session **feature-toggle** surface so the
agent's behaviour can be tuned without redeploying. Flags are plain
booleans keyed by string, defaulted centrally, and overridden only
when the user explicitly flips a toggle. The surface is
intentionally generic so future toggles (e.g. `parallelTools`,
`verboseDebug`) drop in without schema churn.

## Storage

The Dexie database previously scoped to sessions (`SessionStoreDb`)
was migrated to **version 2** in
`packages/web-acp/src/agent/session-store.ts`. The migration adds a
single new object store:

```ts
// version 2 only
this.version(2).stores({
  sessions: '&id, updatedAt, title',
  entries: '++id, sessionId, seq, ts, kind',
  features: '&sessionId',
});

interface FeatureRow {
  sessionId: string;              // primary key
  flags: Record<string, boolean>; // sparse overrides
  updatedAt: number;              // epoch ms
}
```

No data migration runs — the `features` table is simply created. If a
session has never had a toggle flipped the row is absent; consumers
fall back to `FEATURE_DEFAULTS`.

## API: `FeatureStore`

```ts
interface FeatureStore {
  get(sessionId: string): Promise<FeatureSnapshot>;
  set(sessionId: string, key: string, value: boolean): Promise<FeatureSnapshot>;
  clear(sessionId: string): Promise<void>;
}
```

`get` reads the row (if any), merges it on top of `FEATURE_DEFAULTS`,
and returns the resulting snapshot. `set` validates the key against
`FEATURE_DEFAULTS` (unknown keys throw), writes only the override,
and returns the merged snapshot. `clear` removes the row entirely —
useful when a session is deleted.

`FEATURE_DEFAULTS` is the one place that lists every known flag along
with its production default:

| Key | Default | Semantics |
| --- | --- | --- |
| `bashEnabled` | `true` | Register the `bash` tool for the turn when at least one volume is mounted. |
| `forceToolCall` | `false` | DEV-only. When on, the adapter injects `toolChoice: 'required'` into the next `streamSimple` call so the model must emit a tool call. |

Adding a new flag means updating `FEATURE_DEFAULTS`; no migration is
needed because `get()` merges on every read.

## ACP surface

Two extension methods expose the store to the main thread:

- `_bodhi/features/list` — `{ sessionId } → { features, defaults }`.
  `features` is the merged snapshot; `defaults` is
  `FEATURE_DEFAULTS`. The main thread uses `defaults` to render the
  baseline state when no override exists.
- `_bodhi/features/set` — `{ sessionId, key, value } → { features }`.
  Validates the key (unknown → error), rejects DEV-only keys outside
  a DEV build with a `-32004` error, and returns the refreshed
  snapshot on success.

Both methods live under the spec-blessed `_`-prefix because they were
added after the `bodhi/*` name freeze; the older prefix stays only on
the M0/M1 methods to keep their contracts stable.

## DEV gating

`forceToolCall` is **not exposed** in production builds:

1. `FeaturePanel` hides the row when `__WEB_ACP_DEV__` is `false`.
2. `_bodhi/features/set` rejects attempts to flip it outside DEV with
   an explicit error code so a hypothetical third-party client can't
   flip it either.

`__WEB_ACP_DEV__` is wired in via Vite's `define` option
(`packages/web-acp/vite.config.ts`) and declared in
`src/vite-env.d.ts`. The worker build sees the same constant.

The adapter's prompt flow reads both gates before injecting the
override:

```ts
const toolChoice =
  featureSnapshot.forceToolCall && IS_DEV && tools.length > 0
    ? 'required'
    : undefined;
streamOverrides.current = toolChoice ? { toolChoice } : {};
```

`streamOverrides` is a mutable `{ current }` bag shared between the
adapter and `createStreamFn`; the stream fn reads it once per
`streamSimple` invocation and merges the overrides into the pi-ai
call. The bag is reset in `prompt`'s `finally` block so no override
leaks across turns.

## Reference client

`useAcp` surfaces `features`, `featureDefaults`, and `setFeature` so
the UI can render a live toggle list. `FeaturePanel`
(`components/features/FeaturePanel.tsx`) is the reference renderer:

- One row per known flag; unknown keys are ignored (forward
  compatibility).
- DEV-only flags get a `(DEV)` suffix and are filtered out entirely
  in production builds so production users can't see them at all.
- `data-testid="feature-toggle-<key>"` on each checkbox and
  `data-teststate="on"|"off"` on the row make it straightforward to
  drive in Playwright.

## Testing

- **Unit (vitest):** `feature-store` merge semantics (missing row →
  defaults, partial row → partial merge, clear → defaults again).
- **Adapter unit:** exercising `_bodhi/features/set` with a DEV-only
  key in a non-DEV environment should reject with the documented
  error code.
- **e2e (Playwright):** `features.spec.ts` flips `bashEnabled` off,
  sends a prompt, and asserts the model cannot issue a tool call
  (via the absence of `data-testid="tool-call-*"`). The production
  variant of the spec asserts `forceToolCall` is invisible.
