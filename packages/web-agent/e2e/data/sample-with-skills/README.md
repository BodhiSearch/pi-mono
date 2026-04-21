# Sample vault with skills

Used by the `skills.spec.ts` e2e test. Seeds `/vault/.pi/skills/` with a
handful of tiny SKILL packages, each bundling an `SKILL.md` (metadata +
instructions) and a small `.js` script that the model can execute via the
`bash` tool shim:

- `hello-world` — prints a greeting based on `$ARGUMENTS`.
- `fetch-demo` — calls `fetch()` to prove the network capability bridge.
- `vault-writer` — writes a file under `/vault` to prove the sandbox's
  vault read/write surface round-trips through ZenFS.
