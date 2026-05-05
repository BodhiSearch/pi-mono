# pi-greet-fixture

**Origin.** Phase 13 (Phase Z) install-flow fixture. Not a port of a real
`pi.dev` package — it's a tiny, self-contained example we serve from the
e2e test harness's mocked npm registry to exercise
`/extension add <pkg>` end-to-end.

**What it demonstrates.** Sets the bare-minimum `pi.dev`-style manifest:

- `package.json` declares `pi.extensions: ["index.js"]` (the convention
  the install path prefers when present, ahead of `module` / `main`).
- `index.js` is a single self-contained `ExtensionFactory` that registers
  one slash command (`/pi-greet`).

The Phase 13 e2e step:

1. Boots with the wiki volume tagged `agent-wd` so install has a writable
   target.
2. Mocks `https://registry.example.test/pi-greet-fixture` and the matching
   tarball URL with files generated from this folder via `nanotar`.
3. Sends `/extension add pi-greet-fixture` over the chat.
4. Asserts the command's confirmation reply, that `_bodhi/extensions/list`
   now reports `pi-greet-fixture@1.0.0`, and that the registered
   `/pi-greet` command runs.

**Diff vs origin.** No origin — this is synthetic.

**Why a fixture and not a real `pi.dev` package?** The shipped catalog is
overwhelmingly Node-only (subprocess, `node:fs`, ffmpeg, Chromium
cookies). The Phase 13 plan calls out browser-friendliness as a hard
constraint. A self-contained fixture proves the install path works
without coupling the test suite to upstream packages whose APIs may drift.
