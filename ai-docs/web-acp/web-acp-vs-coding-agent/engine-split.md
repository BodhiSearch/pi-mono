# engine-split — applying coding-agent's wire/engine separation to web-acp

## What changed

`packages/web-acp/src/acp/agent-adapter.ts` was a 1,254-line god-object
fusing four roles: ACP wire shim, lifecycle orchestrator, prompt-turn
engine, and services container. The refactor splits these along the
seam coding-agent has had since day one:

```
coding-agent                                web-acp (after split)
─────────────────────────────────────       ───────────────────────────────────────
modes/rpc/rpc-mode.ts          (733 LoC)    acp/agent-adapter.ts          (~245 LoC)
core/agent-session-services.ts (197 LoC)    acp/engine/services.ts        (~75 LoC)
core/agent-session-runtime.ts  (349 LoC)    acp/engine/session-runtime.ts (~410 LoC)
core/agent-session.ts        (3,077 LoC)    acp/engine/prompt-driver.ts   (~370 LoC)
                                            acp/engine/builtin-dispatch.ts (~115 LoC)
                                            acp/engine/ext-methods/*.ts   (~290 LoC, 9 files)
                                            acp/wire-utils.ts             (~175 LoC)
```

The four-layer mapping is the structural insight:

| Layer            | coding-agent                          | web-acp                                                |
| ---------------- | ------------------------------------- | ------------------------------------------------------ |
| Wire shim        | `modes/rpc/rpc-mode.ts`               | `acp/agent-adapter.ts`                                 |
| Services bag     | `core/agent-session-services.ts`      | `acp/engine/services.ts`                               |
| Lifecycle owner  | `core/agent-session-runtime.ts`       | `acp/engine/session-runtime.ts`                        |
| Turn engine      | `core/agent-session.ts`               | `acp/engine/prompt-driver.ts`                          |

## Where web-acp deliberately diverges

**Per-file ext-methods.** coding-agent keeps a 30+ command switch
inline in `rpc-mode.ts:362-639`. web-acp has 8 `_bodhi/*` extension
methods today and a known pipeline of new ones (M5 extensions, M6 fork,
M7 compaction). Splitting each into a dedicated file under
`acp/engine/ext-methods/` means M5/M6/M7 land as new files registered
in `engine/ext-methods/index.ts`, with no merge-conflict on a giant
switch. coding-agent has historical reasons to keep the switch (its
RPC scheme predates today's preferences); we don't.

**Scaled-down driver.** `agent-session.ts` is 3,077 lines because it
holds steering / compaction / retry state machines, message history
diffing, export pipelines, and a thick extension hook surface. web-acp
hasn't shipped most of that yet — the driver runs one prompt turn,
emits chunks + tool-call lifecycle, persists the resulting turn, and
returns. Compaction (M7) plugs into this driver as additional state
machines, mirroring `agent-session.ts`'s pattern. Until then we keep
the file lean.

**No `EventBus` indirection.** coding-agent emits `AgentSessionEvent`s
through `core/event-bus.ts` (33 LoC pub/sub) so the host can subscribe
to internal lifecycle events. web-acp doesn't need this — ACP itself
is our event bus (`session/update` notifications, `_meta.bodhi.*`
extensions). Adding an internal pub/sub on top would be a third
parallel protocol, which is the exact problem the ACP pivot fixed.

**Simpler provider abstraction.** coding-agent threads a
`ModelRegistry` (multi-provider, with credential rotation per provider)
through `AgentSessionServices`. web-acp has one provider
(`BodhiProvider`) and the `LlmProvider` interface in
`packages/web-acp/src/agent/bodhi-provider.ts:33` is unused beyond it.
Commit 7 of the refactor adds a `defaultProviderFactory` seam in
`agent-worker.ts` so a future host app can swap providers, but we
don't pre-build the multi-provider registry.

**`SessionState` is small.** coding-agent's session-manager carries
~25 fields per session (model, MCP servers, retry state, compaction
state, etc.). web-acp's `SessionState` (defined in
`acp/engine/types.ts`) carries 4: `id`, `mcpServers`,
`requestedMcpUrls`, `mcpInstances`. Compaction (M7) and skills (M5+)
will grow this; today it stays narrow.

## What does NOT change on the wire

The ACP wire surface is byte-identical before and after. Same `Agent`
methods (`initialize`, `authenticate`, `newSession`, `loadSession`,
`prompt`, `cancel`, `extMethod`), same `_bodhi/*` extension namespace,
same notification shapes. Existing ACP-compliant clients see no
difference.

## Cross-references

- Architecture diagram: `../steering/02-architecture.md`
- Wire concerns vs engine concerns explained: `../web-acp-vs-standard-acp/engine-split.md`
- Spec file map: `../specs/web-acp/index.md`
- Refactor plan that drove this: `../../packages/coding-agent/src/ai-docs/plans/lets-plan-this-refactor-glowing-donut.md`
