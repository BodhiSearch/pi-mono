# M7 — Polish + Extract

## What this milestone delivers

Everything needed to hand `packages/web-acp/` to a third party as a
reusable library and to give operators enough introspection to
debug production issues.

- **Diagnostics.** A debug panel or console view showing ACP
  message traces (request/response/notification) with timing. Toggle
  via a URL param so shipping to prod doesn't expose internals.
- **Logging.** Structured logs from the agent side, surfaced either
  via ACP extension (`x-bodhiapp/log`) or via a client-side channel
  bolted onto the transport adapter.
- **HTML export.** A session can be exported to a self-contained
  HTML file that a user can share. Reuses web-agent's pattern if it
  maps; otherwise rebuilt around ACP transcripts.
- **Library extraction.** The agent subtree under
  `packages/web-acp/src/` (exact path settled during M0) becomes a
  publishable npm package. Working name: `@bodhiapp/bodhi-web-acp`
  (TBD). The reference app at `packages/web-acp/` consumes it as
  a workspace dep.

## ACP surface touched

- Potentially an ACP extension for structured logs (`x-bodhiapp/log`).
  Alternatively, logs ride on the transport adapter out-of-band
  (not ACP messages) — plan-time decision.
- HTML export is pure client-side serialisation of the ACP
  transcript. No ACP surface needed beyond what M1 already gave us.

## Depends on

- **M6** — extraction must carry the extension runtime if we ship
  one; if extensions land post-M7, the extraction happens twice.
- **M1–M5** at minimum, because the extractable surface must be
  stable.

## Out of scope

- Telemetry / analytics reporting home. Logs are local.
- Automatic update mechanism for installed extensions.
- Breaking-change migration tooling. The library is pre-v1;
  consumers pin exact versions until we declare stability.
- Public documentation site. README + inline JSDoc only.

## Why this ordering

Extraction is the **last** milestone because every prior milestone's
public surface becomes API by being extracted. If we extract early,
every subsequent milestone churns the public API. Extracting at
the end makes the surface a snapshot, not a moving target.

Diagnostics / logging / export are grouped with extraction because
they're what separates "works for us" from "useful to a third
party." Shipping the library without them means every consumer
writes the same debugging harness from scratch.

Library-name decision lands here, not earlier — see M0 open
questions. `@bodhiapp/bodhi-web-acp` is a placeholder; options
include `@bodhiapp/web-acp-agent`, `@bodhiapp/acp-browser-agent`,
or something shorter. Consistency with `@bodhiapp/bodhi-js-react`
and the hypothetical `@bodhiapp/bodhi-web-agent` is the main
consideration.

## Possible split

If the extraction itself turns out to be substantial (most of a
milestone's worth of work), split into **M7-polish** (diagnostics,
logging, export) and **M8-extract** (package lift, peerDependency
reclassification, workspace-consumer wiring). Decide during the
M6 wrap-up.
