# Code Review — M6 Extension Install Flow and npm Registry

**Commit:** `067bed6a` (web-acp: M6 phase 0 through phase 14 — extensions)
**Reviewer scope:** Extension install flow and npm registry surface
**Date:** 2026-05-07

Files reviewed:
- `packages/web-acp-agent/src/agent/extensions/install.ts`
- `packages/web-acp-agent/src/agent/extensions/install.test.ts`
- `packages/web-acp/e2e/helpers/mock-npm-registry.ts`
- `packages/web-acp/e2e/helpers/install-extensions.ts`
- `packages/web-acp-agent/src/acp/engine/ext-methods/extensions-add.ts`
- `packages/web-acp-agent/src/acp/engine/ext-methods/extensions-list.ts`
- `packages/web-acp-agent/src/acp/engine/ext-methods/extensions-reload.ts`
- `packages/web-acp-agent/src/acp/engine/ext-methods/extensions-snapshot.ts`
- `packages/web-acp-agent/src/acp/engine/ext-methods/schemas.ts`

---

## Findings

### 1. Path traversal via attacker-controlled `manifest.name` or `manifest.version`

**Severity: High**
**File:** `install.ts:126-145`

`installExtensionFromNpm` resolves the install directory by reading `manifest.name`
and `manifest.version` directly from the tarball's `package.json` — both of which
are attacker-controlled. These values are passed into `localExtensionDirName` without
any sanitization, then concatenated into an absolute path:

```ts
// install.ts:144-145
const extensionName = localExtensionDirName(resolvedName, resolvedVersion);
const installRoot = `/mnt/${input.agentWdMount}/.pi/extensions/${extensionName}`;
```

`localExtensionDirName` does not reject or sanitize `../` sequences:

```ts
// install.ts:60-63
export function localExtensionDirName(name: string, version: string): string {
  const safe = name.startsWith('@') ? name.replace('/', '__').slice(1) : name;
  return `${safe}@${version}`;
}
```

A tarball whose `package.json` declares:
```json
{ "name": "../evil-package", "version": "1.0.0" }
```
produces `installRoot = /mnt/wiki/.pi/extensions/../evil-package@1.0.0`.
After ZenFS path normalization this resolves to `/mnt/wiki/.pi/evil-package@1.0.0`
— outside the `extensions/` directory. With `version: "../../mnt/other/file"` the
write crosses mount boundaries.

The `registryUrl` parameter is validated by `z.string().url()` in `schemas.ts`, but
that only confirms URL syntax — it does not prevent the fetched tarball from
containing a malicious `name` or `version`. Note: this scenario requires a malicious
npm package (not the default `registry.npmjs.org`) but the `registryUrl` override
is expressly supported and user-facing via `--registry`.

**Fix:** Add a validation step in `localExtensionDirName` (or just before building
`installRoot`) that rejects names or versions containing `/`, `\`, or `.` sequences
that resolve outside the extensions directory:

```ts
function assertSafeDirComponent(value: string, field: string): void {
  if (/[/\\]/.test(value) || /\.\./.test(value)) {
    throw new Error(
      `install: unsafe ${field} '${value}' — path traversal characters not allowed`
    );
  }
}
```

Apply this to both `resolvedName` (after scope-flattening) and `resolvedVersion`
before constructing `extensionName`. Alternatively, validate that `installRoot`
starts with the expected prefix after `path.resolve`/ZenFS normalization.

---

### 2. SSRF risk via `registryUrl` parameter — no protocol or host restriction

**Severity: High**
**Files:** `schemas.ts:29-33`, `extensions-add.ts:44`, `install.ts:101-111`

The `registryUrl` field passes Zod's `z.string().url()` check which accepts any
syntactically valid URL, including `http://`, `file://`, and URLs pointing to
RFC-1918 addresses:

```ts
// schemas.ts:29-33
const extensionsAddParams = z.object({
  spec: z.string().min(1),
  registryUrl: z.string().url().optional(),
}).passthrough();
```

An ACP client (or the LLM itself via `/extension add --registry http://10.0.0.1/...`)
can redirect the agent's metadata and tarball fetches to internal services, cloud
metadata endpoints (`http://169.254.169.254/`), or local ports. The fetch runs inside
the Web Worker and is not subject to any browser CSP constraint at the transport level
beyond CORS (and CORS headers on internal services are often unrestricted in dev
networks).

**Fix:** Validate that `registryUrl` is `https://` only and/or restrict to a
configured allowlist. At minimum, add to the Zod schema or the handler:

```ts
registryUrl: z.string().url().refine(
  u => u.startsWith('https://'),
  { message: 'registryUrl must be an https:// URL' }
).optional(),
```

For a fuller defence, reject RFC-1918 addresses and link-local ranges in
`install.ts:resolveTarballUrl` before issuing the fetch. The tarball URL returned
by the registry metadata response is also unvalidated and could redirect to an
internal host — apply the same scheme check to `tarball` before calling `fetchTarball`.

---

### 3. No partial-install cleanup on failure

**Severity: Medium**
**File:** `install.ts:144-157`

The install sequence is:

```ts
await input.writeFs.rm(installRoot);      // remove old copy
await input.writeFs.mkdir(installRoot);   // create directory
await input.writeFs.writeFile(`${installRoot}/index.js`, entryEntry.text);
await input.writeFs.writeFile(`${installRoot}/package.json`, pkgJsonEntry.text);
```

If either `writeFile` call throws (ZenFS error, quota exceeded, etc.) after `mkdir`
succeeds, the extension directory exists but is incomplete. On the next `reload` the
loader will try to import a missing or empty `index.js`, producing a confusing error
that does not mention the failed install.

**Fix:** Wrap the write sequence in a try/catch that calls `writeFs.rm(installRoot)`
on failure:

```ts
await input.writeFs.rm(installRoot);
await input.writeFs.mkdir(installRoot);
try {
  await input.writeFs.writeFile(`${installRoot}/index.js`, entryEntry.text);
  await input.writeFs.writeFile(`${installRoot}/package.json`, pkgJsonEntry.text);
} catch (err) {
  await input.writeFs.rm(installRoot).catch(() => undefined); // best-effort cleanup
  throw err;
}
```

---

### 4. No concurrency guard on `reload` — simultaneous calls produce torn state

**Severity: Medium**
**Files:** `extensions-reload.ts:15-45`, `extensions-add.ts:46-48`

`extensionsReload` and `extensionsAdd` both call `host.extensions.reload()` with no
mutual-exclusion guard. `ExtensionRegistry.reload()` disposes all active extensions,
clears tool/command/provider maps, and re-runs discovery. If two requests arrive
concurrently (e.g. the user clicks the reload button while an `/extension add` is in
flight), the registry can enter a state where:

- The first caller clears the maps.
- The second caller re-populates partially while the first is mid-discover.
- Both callers broadcast `_bodhi/extensions/state` with snapshots that reflect
  different registry states.

`ExtensionRegistry` has no `#reloading` flag, no promise chaining, and no mutex.

**Fix:** Add a `#reloadChain: Promise<void> = Promise.resolve()` to
`ExtensionRegistry` and chain each `reload()` call onto it:

```ts
reload(): Promise<void> {
  this.#reloadChain = this.#reloadChain.then(() => this.#doReload());
  return this.#reloadChain;
}
```

This is a single-threaded JS runtime so the risk is lower than in a multi-threaded
environment, but two concurrent ACP ext-method calls (which are async) can still
interleave at `await` boundaries.

---

### 5. Error message for non-existent requested version is misleading

**Severity: Low**
**File:** `install.ts:178-183`

When a caller requests `pi-foo@99.0.0` and the registry does not list that version:

```ts
const versionEntry = meta.versions?.[targetVersion];   // undefined
const tarball = versionEntry?.dist?.tarball;           // undefined
if (!tarball) {
  throw new Error(
    `registry metadata for '${name}@${targetVersion}' missing dist.tarball`
  );
}
```

The error says "missing dist.tarball" which implies a corrupt registry response
rather than the actual cause (version does not exist). A developer seeing this
message will look at the tarball URL rather than the version list.

**Fix:** Check `versionEntry` separately:

```ts
if (!versionEntry) {
  throw new Error(
    `version '${targetVersion}' not found in registry metadata for '${name}'`
  );
}
const tarball = versionEntry.dist?.tarball;
if (!tarball) {
  throw new Error(`registry metadata for '${name}@${targetVersion}' missing dist.tarball`);
}
```

---

### 6. `install.test.ts` missing coverage for: network failure, already-installed collision, scoped-package full install, entry-not-in-tarball

**Severity: Medium**
**File:** `install.test.ts`

Current `installExtensionFromNpm` test cases:
- Happy path (bare name, `module` entry).
- `pi.extensions[0]` preference over `module`/`main`.
- Rejection of packages with no entry hint.

Not covered:

**a. Metadata fetch failure (HTTP 500/network error).** The `resolveTarballUrl` error
path is untested. A registry that returns 500 should surface a clear message; the
current test harness never exercises this.

**b. Already-installed collision (reinstall).** The `rm` + `mkdir` sequence that
implements "reinstall" is untested. Verify that a second install of the same package
overwrites cleanly and that partial state from the first is gone.

**c. Scoped package full round-trip.** `parseNpmPackageSpec` is tested for scoped
parsing and `localExtensionDirName` is tested for the naming transform, but there is
no integration test in `installExtensionFromNpm` that actually installs a `@scope/pkg`
package end-to-end. The `encodeRegistryName` function is exercised only via `fetch`
mock URLs that the unit test constructs manually, not via the production code path
with a scoped name.

**d. Entry path not present in tarball.** When `package.json` declares
`"module": "dist/index.mjs"` but the tarball does not include that file, the code
throws `entry '${entryRel}' was not present in the tarball`. This branch is not
tested.

**e. Malformed `package.json` in tarball.** `JSON.parse(pkgJsonEntry.text)` will
throw a `SyntaxError` for invalid JSON. No test covers this.

**Fix suggestions:**
- Add a `it('surfaces registry error', ...)` test where `fetchImpl` returns status
  500 for the metadata URL.
- Add a `it('reinstalls cleanly over existing directory', ...)` test that calls
  `installExtensionFromNpm` twice with the same spec and asserts the second write
  replaces the first.
- Add a `it('installs a scoped package end-to-end', ...)` test using a `@scope/name`
  spec through the full `installExtensionFromNpm` path (not just `parseNpmPackageSpec`
  and `localExtensionDirName` in isolation).
- Add a `it('rejects package whose entry is absent from tarball', ...)` and a
  `it('rejects package with invalid package.json', ...)` test.

---

### 7. `mock-npm-registry.ts` duplicates `encodeRegistryName` without sharing from `install.ts`

**Severity: Low**
**Files:** `mock-npm-registry.ts:107-113`, `install.ts:199-206`

Both files contain byte-identical `encodeRegistryName` implementations. If the
encoding logic in `install.ts` ever diverges (e.g. to handle `%2F` vs `%2f`
case-sensitivity or other edge cases), the mock will silently stop matching real
requests and the e2e test will pass for the wrong reason.

The `last()` helper in `mock-npm-registry.ts` (used to build the `.tgz` filename)
is also not shared and produces a tarball URL pattern (`name/-/shortname-version.tgz`)
that matches the npm registry convention, but if `install.ts` ever followed a tarball
URL from the metadata response that deviated from this pattern, the mock would still
match (since it registers the metadata URL which returns a `tarballUrl` the mock also
intercepts). In practice the mock is self-consistent; this is a maintenance risk
rather than a functional bug.

**Fix:** Export `encodeRegistryName` from `install.ts` (or a shared utility) and
import it in `mock-npm-registry.ts`. The function is a pure utility with no
side effects; exporting it from the test-utils barrel is sufficient.

---

### 8. `extensions-add.ts` does not validate Zod schema before casting `params`

**Severity: Low**
**File:** `extensions-add.ts:29-32`

`extensionsReload` and `extensionsAdd` both cast `params` as their typed request shape
without running the Zod schema registered in `EXT_METHOD_SCHEMAS`:

```ts
// extensions-add.ts:29
const req = (params ?? {}) as BodhiExtensionsAddRequest;
if (typeof req.spec !== 'string' || req.spec.trim() === '') {
  throw new Error('extensions:bad-request — ...');
}
```

The schema dispatch in `acp/engine/ext-methods/index.ts` runs `EXT_METHOD_SCHEMAS`
before calling the handler, so `registryUrl` will have been validated as a URL by
the time `extensionsAdd` receives `params`. However, the manual check inside the
handler only re-validates `spec`. If the dispatch layer is ever bypassed in a test
or refactored, `registryUrl` validation is silently skipped.

**Fix:** Either trust the dispatch layer exclusively and remove the manual `spec`
check (or vice versa — remove the schema entry and validate entirely in the handler),
or at minimum add a comment explaining that Zod validation has already run.

---

### 9. `parseNpmPackageSpec` does not reject semver ranges or tag aliases

**Severity: Low**
**File:** `install.ts:34-57`

The parser accepts any string after the `@` separator as a `version`. npm supports
version ranges (`^1.0`, `~1.0`, `>=1.0 <2.0`) and dist-tag aliases (`latest`,
`next`, `beta`). The current install logic passes the `version` string as-is to
`meta.versions?.[targetVersion]` which will return `undefined` for ranges (they are
not keys in the `versions` object) and for unresolved tags. The error message will
say "missing dist.tarball" (finding 8 above).

More importantly, dist-tag names like `latest` would look up `meta.versions.latest`
which would also be `undefined`, even though the correct behaviour is to follow
`meta['dist-tags'].latest`.

**Fix:** After parsing, detect common non-version inputs:
- If `version` matches a semver range (contains `^`, `~`, `>=`, `<=`, `>`, `<`,
  spaces, or `*`) — reject with a clear error explaining that only exact versions
  are supported.
- If `version` looks like a tag name (alpha characters, no dots) — either follow
  `meta['dist-tags'][version]` or reject with a clear error.

The simplest fix for M6 is to reject everything that doesn't match a basic
`\d+\.\d+\.\d+` pattern and document the limitation.

---

### 10. `extensions-reload.ts:28` — empty-array edge case comment

**Severity: Nit**
**File:** `extensions-reload.ts:28`

The condition `if (incoming)` is truthy for an empty array (`[]`), which correctly
allows the caller to re-enable all extensions by passing `disabled: []`. This is
the intended behaviour but is not obvious from reading the code; the variable name
`incoming` and the falsy check `if (incoming)` suggest "did the caller pass
something?" rather than "did the caller explicitly set the list?" A developer
might inadvertently change `if (incoming)` to `if (incoming?.length)` thinking
they are cleaning up, which would break the "re-enable all" semantic.

**Fix:** Add a comment or rename the pattern:

```ts
// `incoming` is null when `disabled` was omitted, [] when caller wants to clear all.
// An empty array is a valid (truthy) explicit list — do not coerce to null/false.
const incoming: string[] | null = Array.isArray(req.disabled)
  ? req.disabled.filter((v): v is string => typeof v === 'string')
  : null;
```

---

### 11. `install.ts:122` vs `install.ts:138` — inconsistent emptiness check for `text`

**Severity: Nit**
**File:** `install.ts:122,138`

```ts
if (!pkgJsonEntry || !pkgJsonEntry.text) { ... }   // falsy check — catches ''
...
if (!entryEntry || entryEntry.text === undefined) { ... }   // strict — misses ''
```

For `nanotar`, a zero-byte tarball entry produces `data: undefined` and `text`
returns `''` (empty string via `TextDecoder.decode(undefined)`). The `pkgJsonEntry`
check correctly rejects an empty `package.json` with a falsy guard. The
`entryEntry` check uses `=== undefined` which would not catch a zero-byte entry;
the empty string would be written as `index.js`, the extension would then fail at
load time when the loader finds no default export. The failure mode is harmless
(loud error at load time rather than at install time) but the inconsistency is
confusing.

**Fix:** Use the same guard for both:

```ts
if (!entryEntry || !entryEntry.text) {
  throw new Error(...);
}
```

---

## Summary table

| # | File | Lines | Severity | Issue |
|---|------|--------|----------|-------|
| 1 | `install.ts` | 126-145 | **High** | Path traversal via attacker-controlled `manifest.name`/`manifest.version` in `localExtensionDirName` |
| 2 | `schemas.ts`, `install.ts` | 29-33, 101-111 | **High** | SSRF via unvalidated `registryUrl` (protocol + host not restricted); tarball URL also unvalidated |
| 3 | `install.ts` | 144-157 | Medium | No partial-install cleanup — failed `writeFile` leaves orphaned directory |
| 4 | `extensions-reload.ts`, `extensions-add.ts` | 15-45, 46-48 | Medium | No concurrency guard on `reload`; two concurrent calls produce torn registry state |
| 5 | `install.ts` | 178-183 | Low | Misleading error message when requested version does not exist in registry |
| 6 | `install.test.ts` | various | Medium | Missing test coverage: network failure, reinstall collision, scoped e2e, entry-absent, malformed JSON |
| 7 | `mock-npm-registry.ts` | 107-113 | Low | Duplicate `encodeRegistryName` — divergence risk |
| 8 | `extensions-add.ts` | 29-32 | Low | Manual `spec` validation duplicates Zod schema; `registryUrl` Zod validation may be bypassed in future refactors |
| 9 | `install.ts` | 34-57 | Low | `parseNpmPackageSpec` silently accepts semver ranges and tag aliases that will not resolve at install time |
| 10 | `extensions-reload.ts` | 28 | Nit | `if (incoming)` truthy-on-empty-array semantic needs a comment to prevent future breakage |
| 11 | `install.ts` | 122, 138 | Nit | Inconsistent emptiness checks for `text` field (`!pkgJsonEntry.text` vs `=== undefined`) |

---

## Overall assessment

The install flow is clean in its overall structure: metadata fetch → tarball fetch →
parse → entry resolution → write is easy to follow, the `fetchImpl` injection makes
the unit tests straightforward, and the `ExtensionsWriteFs` abstraction keeps
production ZenFS code isolated from the logic under test. The Zod schema registration
in `schemas.ts` is a good pattern.

The two **High** findings block ship-readiness:

- Finding 1 (path traversal) is exploitable whenever a user installs from a
  non-default registry whose packages can craft malicious `package.json` names or
  versions. Because `--registry` is user-facing and documented, a non-default registry
  is an expected use case.
- Finding 2 (SSRF) lets the LLM or a host-level ACP client direct the agent's fetch
  to internal services. In the browser the Worker's fetch will include the page's
  origin credentials on same-site requests, amplifying the risk.

Both fixes are small (input validation, schema refinement) and do not require
architectural changes. The **Medium** findings (partial-install cleanup, reload
concurrency) are correctness issues rather than security issues and can be addressed
in a follow-up. The test coverage gaps should be filled before M6 is declared gate-
complete since the install path is exercised only with a single happy path and one
error case.
