# skills

**Source of truth:**
`packages/web-agent/src/worker-agent/core/commands/skills.ts`,
`packages/web-agent/src/worker-agent/core/commands/registry.ts`,
`packages/web-agent/src/worker-agent/core/system-prompt.ts`,
`packages/web-agent/src/sandbox/`,
`packages/web-agent/src/hooks/useSkillSandbox.ts`.

**Parent:** [`./index.md`](./index.md)

## Functional scope

Skills are self-contained capability packages the user drops into the
vault at `<vaultMount>/.pi/skills/<skill-name>/SKILL.md` (+ any number
of scripts or resource files next to it). They are the web-agent port
of `packages/coding-agent`'s skills subsystem, adapted to the browser
runtime:

- **Discovery.** The worker scans `<vaultMount>/.pi/skills/` after the
  vault is mounted and every time `/reload` is dispatched.
- **Prompting.** Loaded skills are appended to the worker-owned
  system prompt so the model knows what each skill does and how to
  invoke it (the same XML block shape `coding-agent` emits).
- **Expansion.** Typing `/skill:<name> [args]` expands into a
  `<skill name=… location=…>` wrapper before the user message is
  sent to the model.
- **Execution.** Scripts under `.pi/skills/` run inside a sandboxed
  JavaScript runtime. The model invokes them through a restricted
  `bash` tool that only accepts `node <path>.js` / `./<path>.js`
  forms pointing at `<vaultMount>/.pi/skills/**/*.js`.

Explicit non-responsibilities:

- **Not an arbitrary shell.** The `bash` tool is a strict shim over
  the JS sandbox; it rejects anything that isn't a skill script
  invocation. There is no PTY, no pipelines, no subprocess host.
- **No Node runtime.** Scripts run as web Workers with a curated
  capability API. `fs`, `child_process`, `require`, dynamic `import`
  are all unavailable.

## Technical reference

### Skill loader — `core/commands/skills.ts`

Mirrors `packages/coding-agent/src/core/skills.ts` but is structured
around an injectable `SkillLoaderOps` (`ls.stat`, `ls.readdir`,
`read.readFile`) so it can be driven by `VaultOperations` in the
worker and by in-memory fakes in tests.

| Export | Purpose |
| --- | --- |
| `Skill` | `{ name, description, filePath, baseDir, disableModelInvocation? }`. |
| `SkillDiagnostic` | `{ type: 'parse' \| 'validation' \| 'collision', message, path }`. |
| `LoadSkillsResult` | `{ skills, diagnostics }`. |
| `loadSkillsFromVault(ops, vaultMount)` | Walks `<vaultMount>/.pi/skills/`, parses each `SKILL.md`, de-duplicates by `name`, returns a sorted list + diagnostics. Missing root returns `{ skills: [], diagnostics: [] }`. |
| `formatSkillsForPrompt(skills)` | Emits the `<available-skills>` XML block appended to the system prompt. Hides skills whose `disableModelInvocation` is set. |
| `stripSkillFrontmatter(content)` | Removes the YAML frontmatter before wrapping a skill body in a `<skill>` block. |
| `SKILLS_DIR_SEGMENT` | `.pi/skills`. |
| `MAX_NAME_LENGTH`, `MAX_DESCRIPTION_LENGTH` | Validation caps ported from coding-agent. |

Validation is identical to `coding-agent`: name must be
`[a-z0-9][a-z0-9-]*`, no consecutive hyphens, no trailing hyphen,
length-capped; description is required and length-capped. When the
frontmatter `name` conflicts with the parent directory name, the
directory name wins (matches coding-agent's `name-mismatch` behaviour).

### Registry integration — `core/commands/registry.ts`

`CommandRegistry` tracks skills alongside builtins and prompt
templates:

- `loadSkillsFromVault(ops, vaultMount)` — delegates to
  `skills.ts` and stashes `skills` + diagnostics on the registry.
- `list()` appends `/skill:<name>` entries with
  `source: 'skill'` and a `disableModelInvocation` flag. The palette
  surfaces every skill; the system-prompt formatter hides the
  disabled ones.
- `findSkill(name)`, `getSkills()`, `getSkillDiagnostics()` —
  accessors used by `expandSkill` and the worker host.
- `expandSkill(text, readOps)` — if `text` starts with `/skill:`,
  reads the referenced `SKILL.md`, strips its frontmatter, and
  returns
  ```
  <skill name="…" location="/vault/.pi/skills/…/SKILL.md">
  References are relative to /vault/.pi/skills/…/.

  <markdown body>
  </skill>

  <original args, if any>
  ```
  Unknown skills pass through unchanged.
- `expandAsync(text, readOps)` — composes `expandSkill` with the
  existing `expandPromptTemplate` so the worker can call one method
  per prompt.
- `clearSkills()` + `clearAll()` reset both collections.

### Worker system prompt — `core/system-prompt.ts`

`buildSystemPrompt({ customPrompt?, cwd?, skills?, hasReadTool?, now? })`
produces the exact string assigned to `agent.state.systemPrompt`.
Layout:

1. `customPrompt ?? DEFAULT_BODY` (the trimmed port of
   coding-agent's default body).
2. If `hasReadTool && skills.length > 0`, the output of
   `formatSkillsForPrompt(skills)`.
3. `Current date: YYYY-MM-DD`.
4. `Current working directory: <cwd>` (optional).

The worker calls this helper from `rebuildSystemPrompt()` after
every mount / reload / unmount event — there is no longer a
`setSystemPrompt('')` call on the main thread.

### Worker host wiring — `worker/worker-host.ts`

`WorkerAgentHost` now retains the active `VaultOperations` so the
command registry can read `SKILL.md` bodies during expansion, and
rebuilds the prompt at every filesystem transition:

| Event | Host behaviour |
| --- | --- |
| `mountVault(handle)` / `mountDevSeed(seed)` | Build `vaultTools`, load prompt templates, `commands.loadSkillsFromVault(ops, vaultMount)`, `refreshTools()`, `rebuildSystemPrompt()`. |
| `reloadCommands()` | Reload both prompts and skills, then `rebuildSystemPrompt()`. |
| `unmountVault()` | `commands.clearAll()`, drop the cached `VaultOperations`, `rebuildSystemPrompt()` (falls back to the skill-free default body). |
| `prompt(message)` | `message = await commands.expandAsync(message, vaultOps.read)` before delegating to the agent. |

### Sandbox — `src/sandbox/`

Lives **outside** the `worker-agent/` folder because it must hold a
real DOM reference (an `<iframe>`). The sandbox is the host-side
execution engine behind the `bash` shim.

| File | Responsibility |
| --- | --- |
| `types.ts` | Wire-level messages between host, sandbox iframe, and skill Worker (`SandboxRunInput`, `SandboxRunResult`, `SandboxCapabilityRequest`, etc.). |
| `bootstrap.ts` | `SKILL_WORKER_SOURCE` — the Worker bootstrap run inside the sandbox iframe; `buildIframeSrcdoc()` — the HTML injected via `srcdoc`. |
| `SandboxHost.ts` | Main-thread orchestrator. Creates one hidden `<iframe sandbox="allow-scripts">`, spawns a fresh Worker per run (from a Blob URL inside the iframe), arms a timeout, and resolves with `SandboxRunResult`. |
| `capabilities.ts` | `buildDefaultCapabilityHandler({ vaultMount, onConsole })` — the main-thread implementation of the capabilities requested by the skill Worker: vault read/write/ls against ZenFS, `fetch()` with a credential-header blocklist, and console piping. |
| `bash-skill.ts` | `BASH_SKILL_TOOL_DESCRIPTOR` + `BashSkillService`. Parses the `bash` command string, reads the target script from the main-thread ZenFS, runs it via `SandboxHost.run`, and formats `stdout/stderr/exitCode` into a tool result. |
| `index.ts` | Barrel — re-exports the public interfaces above. |

The isolation story:

1. The iframe is same-origin at `about:srcdoc` but runs with only
   `allow-scripts` in the `sandbox` attribute, so it cannot reach
   `localStorage`, cookies, or any host-origin resource via its own
   fetches.
2. Every run spawns a fresh Worker inside the iframe, from an
   inline Blob URL. Terminating the Worker (either on timeout or
   completion) discards all JS state for that run.
3. Capability requests round-trip Worker → iframe → host via
   structured-clone messages, and the host enforces path and
   header policy before making the real call.

### Bash shim parser rules — `src/sandbox/bash-skill.ts`

`parseBashSkillCommand(command, vaultMount = '/vault')` accepts:

```
node <path>.js [args...]
./<path>.js [args...]
<path>.js  [args...]   # relative to vaultMount
```

…and rejects everything else with a descriptive error. The resolved
script path must begin with `<vaultMount>/.pi/skills/`. Any other
form (`bash -c …`, `cat …`, `rm …`, shell operators, pipelines) is
returned as `{ error }` and surfaced as an `isError` tool result.

### Main-thread wiring — `src/hooks/useSkillSandbox.ts`

`useSkillSandbox()` owns the `SandboxHost` lifecycle for the React
app:

1. Creates one `SandboxHost` per component mount (via `useRef`).
2. Wraps it in a `BashSkillService`.
3. Returns `{ descriptor, handler }` where `descriptor` is
   `BASH_SKILL_TOOL_DESCRIPTOR` and `handler` is a `ToolCallHandler`
   that dispatches `bash` calls into `service.invoke(args)`.
4. On unmount, calls `sandbox.dispose()` to tear down the iframe
   and reject any pending jobs.

`ChatDemo.tsx` merges the skill descriptor with the MCP descriptors
from `useMcpAgentTools` and the handler falls through to the MCP
handler for any non-`bash` tool, so the worker sees a single flat
tool list.

## Tests

- `core/commands/skills.test.ts` (via `commands/registry.test.ts`) —
  validation, collision handling, `disableModelInvocation` visibility
  in palette vs system prompt.
- `core/commands/registry.test.ts` — `loadSkillsFromVault`, the
  `/skill:<name>` list entry, `expandSkill` XML wrapping,
  `clearSkills` / `clearAll` semantics.
- `core/system-prompt.test.ts` — default body, skill appending,
  `hasReadTool` gating, custom prompts, CWD branches.
- `sandbox/bash-skill.test.ts` — strict parser; accepted vs rejected
  command shapes, path-traversal rejection.
- `e2e/skills.spec.ts` — end-to-end: palette entry, `/skill:` XML
  expansion, model-driven `bash` invocation of `hello-world`,
  `vault-writer` round-trip through the capability bridge,
  `/reload` transient surfacing the skill count.

## Constraints

1. **No node-only imports.** The sandbox runs in the browser; scripts
   see only the curated capability surface.
2. **Path scoping.** Both the `bash` parser and
   `buildDefaultCapabilityHandler` reject any vault path outside
   `<vaultMount>/…`.
3. **Header policy.** `fetch()` strips `authorization` and `cookie`
   from every request so sandboxed scripts cannot exfiltrate
   credentials set on the host origin.
4. **Termination.** Every run is timeout-bounded. `SandboxHost.run`
   resolves with `exitCode: 124` and terminates the Worker if the
   timeout fires.

## Change procedure

Any plan that edits `core/commands/skills.ts`, `core/system-prompt.ts`,
`core/commands/registry.ts` (skill paths), `worker/worker-host.ts`
(skill loading), or anything under `src/sandbox/` must update this
file in the same PR. See [`./index.md` § Change procedure](./index.md#change-procedure).
