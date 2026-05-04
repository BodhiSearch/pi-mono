# Chapter 5 — `/bodhiapp:status` + e2e

> Goal: surface the embedded-agent ack as a CLI command that runs on
> demand, and prove the whole loop end-to-end. Two source edits, one
> e2e step.

## 5.1 The dispatcher edit

`src/dispatcher.ts` already routes `/quit` and `/token`. Two changes:

```ts
export interface DispatchContext {
  emitter: Emitter;
  cwd: string;
  agent: EmbeddedAgent | null;     // new
}
```

Adding `agent` to the context means handlers can call into the live
embedded connection. `null` covers the `skipAuth: true` path used by
the unit /quit test — handlers must check before using.

The new branch:

```ts
if (line === "/bodhiapp:status") {
  await emitStatus(ctx);
  return { exit: false };
}
```

```ts
async function emitStatus(ctx: DispatchContext): Promise<void> {
  if (!ctx.agent) {
    ctx.emitter.emit({ text: "agent not started" });
    return;
  }
  const info = await ctx.agent.serverInfo();
  ctx.emitter.emit({
    text: `BodhiApp ${info.status} at ${info.url} (version ${info.version})`,
    ...info,
  });
}
```

Two things to notice:

- We emit *both* a human-readable `text` line *and* the structured
  fields (`status`, `url`, `version`, `client_id` if present). In
  plain mode the test field is what the user reads; in `--test` mode
  the JSON-line emission carries every field for the harness to
  assert on.
- The same `info` shape was already emitted once at startup (from
  `bootstrap.ts:startAgent`). `/bodhiapp:status` re-runs the call, so
  if BodhiApp goes down mid-session you can re-check.

## 5.2 The bootstrap signature change

`bootstrap.ts` now passes `agent` into the dispatcher:

```ts
rl.on("line", async (raw) => {
  const result = await dispatch(raw.trim(), { emitter, cwd: opts.cwd, agent });
  // ...
});
```

When `skipAuth: true` the `agent` is `null`. The unit test in
`test/quit.test.ts` exercises that path; it asserts `/quit` works
without touching the agent code path at all.

## 5.3 The e2e step

`e2e/auth.spec.ts` now has five `test.step`s. Four of them are
unchanged (login URL emit → browser flow → tokens.json → `/token`
JWT). The new fifth step:

```ts
await test.step("/bodhiapp:status proxies through the embedded agent", async () => {
  harness.send("/bodhiapp:status");
  const statusEvent = await harness.waitFor(
    (ev) => typeof ev.status === "string" && typeof ev.url === "string",
  );
  expect(statusEvent.status).toBe("ready");
  expect(statusEvent.url).toBe(state.bodhiServerUrl);
  expect(typeof statusEvent.version).toBe("string");
});
```

What each assertion proves:

- `status === "ready"` — BodhiApp accepted the JWT, returned its
  setup state, and the state is the post-setup happy path. If the
  e2e global-setup ever skipped the `/setup` flow, this would fail
  with `"setup"`/`"resource_admin"`/etc.
- `url === state.bodhiServerUrl` — BodhiApp echoed back the URL it
  thinks it's running on. Loose proof that the network round-trip
  was real (we didn't get a cached response from somewhere).
- `version` is a string — anything sane suffices; we don't pin a
  version in case BodhiApp bumps.

## 5.4 What the green test proves end-to-end

When `npm run test:e2e` passes you've verified:

1. The CLI's OAuth round-trip lands a JWT (Chapters 1-2 of the
   build, this tutorial's prerequisite).
2. `startAcpAgent` boots the embedded agent against an in-memory
   duplex (Chapter 4).
3. ACP `initialize` + `authenticate` complete without error.
4. The new `_bodhi/server/info` ext method round-trips: client →
   `extMethod` → handler → `BodhiProvider.fetchServerInfo` →
   real HTTP → BodhiApp → `/bodhi/v1/info` → JSON back → wire
   response → CLI emit (Chapters 2 + 3).
5. The `agent` value threaded into `DispatchContext` is the live
   connection — `/bodhiapp:status` runs against a real bound
   instance, not a placeholder.

That's the integration the user asked for: token push at the right
sequence + a meaningful ack from the agent.

## 5.5 Things we deliberately didn't do

- **No retries / refresh.** The token in `tokens.json` is good for
  one OAuth lifetime; on expiry we re-run the browser flow.
  Production hosts (cli-acp-client) refresh; the tutorial doesn't.
- **No agent restart.** The embedded agent stays up for the life of
  the REPL. Re-running `/bodhiapp:status` calls the same connection;
  a new auth wouldn't propagate without a restart. Adding that is
  a small change (close + recreate) when the next chapter needs it.
- **No `prompt` / streaming.** `sessionUpdate` is a no-op handler
  in `embed.ts`. The next milestone of the tutorial picks up from
  here and starts driving model turns; that's where the registry,
  stores, and `sessionUpdate` reducer all start mattering.

## 5.6 Running it locally

```sh
cd packages/tutorial-cli-client

# happy path:
npm run dev
# (browser opens to BodhiApp consent, then Keycloak; CLI emits
#  "BodhiApp ready at http://localhost:51135 (version …)" and the
#  prompt becomes available)

# at the prompt:
> /bodhiapp:status
BodhiApp ready at http://localhost:51135 (version …)
> /quit
application exited
```

```sh
# e2e:
npm run test:e2e
# Boots BodhiApp on :41135 via global-setup, drives the OAuth flow
# headlessly via Playwright, asserts every step.
```

## 5.7 What's next

We have a working agent embed and a connectivity ack. The next
steps for the tutorial:

- mount `$cwd` as a volume so the agent's `bash` tool gets
  registered;
- wire `prompt()` and the streaming reducer so the CLI renders
  assistant turns;
- add a `SessionStore` so `/sessions` works and we can replay.

Each builds additively on what's here. The four-call sequence from
Chapter 2 stays the same; we're only widening the surface the CLI
drives.
