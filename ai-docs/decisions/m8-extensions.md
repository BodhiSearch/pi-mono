# M8 — extensions runtime shape decisions

Date: 2026-04-20

> **Spike-era record.** D20 below describes choices made inside the M8 research spike. It is archived, not committed as forward direction. The archive at [`../extension-spike/`](../extension-spike/) contains the feasibility report, gap analysis, and an unbiased from-scratch recommendation; the next iteration should draw from those before overturning or re-affirming D20 with a new entry. D21 is a general lifecycle rule that stands regardless of where extensions run.

## D20. Extensions load via Dexie bytes + Blob URL + per-extension nested Worker

**Decision:** every installed extension is stored as UTF-8 ESM source in Dexie (`ExtensionBundleRow.bytes` + a separate `ExtensionEnabledRow` flag). At load time the agent Worker spawns a nested dedicated Worker (`web-agent-extension-host`) running `src/web-agent/core/extensions/host/host-worker.ts`, hands it the manifest and the bundle text, and the host Worker rebuilds the ESM into a `Blob URL` and dynamic-`import()`s that URL. The Blob URL is revoked immediately after import resolves. Registered tools, `before_agent_start` system-prompt mutations, and `tool_result` content mutations flow back over a small RPC (`HostCommand` / `HostMessage`) between the supervisor (inside the agent Worker) and the extension host Worker.

**Why.**

- **No fetch / CORS / CSP dependencies at load time.** The bytes already live in IDB after install; rehydration is a pure local operation, so the runtime is offline-capable and does not depend on the origin the extension came from being reachable.
- **One extension per Worker = crash isolation.** A faulty extension cannot take down the agent Worker. Terminating a misbehaving extension is `worker.terminate()` — no interpreter surgery.
- **Blob URL + dynamic `import()` is the cheapest way to run unbundled ESM in a Worker** without shipping our own module loader. Vite's `/* @vite-ignore */` comment keeps the dev server from trying to analyse it statically.
- **Permission surface can be enforced per-Worker.** Shadowing `self.fetch` inside the host Worker with a wrapper that checks `manifest.permissions.netOrigins` is ~20 lines and impossible for the extension code to bypass, because it runs before the extension's factory does.
- **Hot-swap without restarting the agent Worker is possible** because the agent Worker's lifecycle does not own the extension's runtime. Enable / disable just spawns / terminates a nested Worker; the in-flight agent turn is never interrupted.

**Alternatives rejected:**

- *Run extensions inline in the agent Worker (no nested Worker).* Crash-isolation regression; a faulty extension breaks the whole agent. Rejected at the research gate.
- *Use iframes as the sandbox.* Required for DOM-adjacent extensions (e.g. renderers) but overkill for headless code that only needs isolated execution. Deferred to M9's `registerMessageRenderer` work.
- *Load bundles over `fetch` at every boot.* Couples runtime to network posture and CSP policy of the origin; hostile on first load after reload in a degraded network.
- *Use `new Function(...)` or `eval` to run the bundle.* Rejected: no ESM semantics (`import` / `export` don't work), and CSP-hostile.
- *OPFS-backed bundle storage.* Vetoed by the repo-level Principle #2 (storage is IDB, not OPFS).

## D21. Mid-stream extension toggles defer to the next `agent_end`

**Decision:** calling `setExtensionEnabled(id, enabled)` while the agent is actively streaming does **not** load or unload the extension immediately. The host records the desired state in `pendingExtensionChanges` and emits an `extension_pending` event so the UI can render a "Will apply at end of turn" badge. `WorkerAgentHost` flushes the map inside the existing `agent_end` subscription, applying each pending change atomically before the next turn can start.

**Why.**

- **Tool set stability mid-turn.** `AgentSession.setTools` is safe to call mid-stream but changes to the `tool_result` handler chain mid-stream would produce inconsistent transcripts (some tool results go through the chain, later ones don't). Deferring is the simplest way to guarantee a turn sees one consistent extension state.
- **Matches the compaction deferral pattern.** M7 compaction queues the compaction until `agent_end` for the same reason. Reusing the pattern keeps the WorkerAgentHost's lifecycle story uniform.
- **UX is observable.** The `extension_pending` event surfaces pending state in the UI, so a user toggling during a stream knows their change is queued — not dropped.

**Alternatives rejected:**

- *Apply immediately and accept inconsistency.* Rejected; subtle bugs only visible on long turns, and violates the "one consistent tool set per turn" invariant the agent harness already implies.
- *Abort the current turn on toggle.* Aggressive. Users toggling to experiment shouldn't lose their in-flight reply.
