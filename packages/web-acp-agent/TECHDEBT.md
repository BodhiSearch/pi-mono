# web-acp-agent — known tech debt

## Per-session volume namespacing (open)

**Symptom.** All sessions handled by one `web-acp-agent` instance
share the same `VolumeRegistry`. Every `_bodhi/volumes/list` call,
every `composeSystemPrompt` invocation, every bash-tool
`MountableFs` lookup exposes the union of every volume mounted on
that registry. A new mount via `registry.mount(init)` becomes
visible to every active session — no per-session scoping.

**Root cause.** `@zenfs/core@2.5.6` exposes a single process-global
`mounts` map (`dist/vfs/shared.js`). `bindContext({ root })` gives
a chrooted view but still shares the same mount table — adding a
mount via the bound view writes into the same global map. Per-
context isolated mount tables are tracked upstream at
[zen-fs/core#218](https://github.com/zen-fs/core/issues/218); not
shipped. The agent currently reaches the global VFS directly through
`@zenfs/core`'s `fs.promises.*` inside
`agent/tools/volume-filesystem.ts:VolumeFileSystem` and
`agent/commands/loader.ts:createZenfsCommandsFs`, so even adding
`bindContext` would be a non-trivial change — every consumer would
need to thread a session-bound `BoundContext` instead of the global.

**Impact today.**
- `ws-acp-client` runs one `cwd` mount shared across sessions in
  a single-tenant deployment — isolation problem is not exercised.
- `web-acp` is single-user (one browser tab, one session at a time
  on the foreground UI). The worker hosts only one session
  registry; new volumes are added by user action in the same tab.
- `tutorial-cli-client` mounts nothing.

**Migration shape (when ready).**
- `VolumeInit.fs: FileSystem` becomes `VolumeInit.createFs: () =>
  Promise<FileSystem> | FileSystem` (factory). ZenFS mutates
  `fs._mountPoint` per `dist/vfs/shared.js:31`, so a single
  `FileSystem` instance cannot be safely mounted at multiple paths
  — each session needs its own instance pointing to the same
  underlying physical resource (e.g. two `PassthroughFS('/cwd')`
  instances or two `WebAccess({ handle })` instances over the same
  FSA handle).
- `VolumeRegistry.{mount,unmount,list,firstMountName,onChange}`
  become session-keyed: `mount(sessionId, init)`, `list(sessionId)`,
  `releaseSession(sessionId)`, etc.
- Mount path becomes `/mnt/<sessionId>/<mountName>`.
  `agent/tools/bash-tool.ts`, `agent/commands/loader.ts`,
  `agent/system-prompt.ts`, `acp/engine/ext-methods/volumes-list.ts`
  thread `sessionId` through.
- `startAgent` gains `defaultVolumes?: VolumeInit[]` (or a
  factory) auto-mounted on `newSession` / `loadSession` and
  auto-released on `closeSession`.

**Threat-model note.** Cooperative isolation through the agent's
own tools is sufficient for the current first-party-tools
deployment — bash + read/write/edit are the only filesystem
surfaces, and the agent constructs the paths it sends to ZenFS.
A defense-in-depth `bindContext({ root: '/mnt/<sid>' })` wrapper
around `VolumeFileSystem` and the commands FS is a follow-up to
the namespacing work above (it doesn't isolate the mount table,
only the path prefix the consumer sees).
