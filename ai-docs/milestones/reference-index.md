# Coding-agent ↔ web-agent reference quick-index

Source-mapping table for porting work. Coding-agent sources are read-only references — we copy patterns, never import (see principle #1 in `../04-principles.md`).

| Area                     | Coding-agent source (read, don't import)                                                     | web-agent milestone                                       |
| ------------------------ | -------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Agent loop + session     | `packages/agent/src/agent.ts`, `packages/coding-agent/src/core/agent-session.ts`             | M1 (done)                                                 |
| Tool schemas             | `packages/coding-agent/src/core/tools/*.ts`                                                  | M3                                                        |
| Tool operations pattern  | Each tool's `create*Tool({ operations })` factory                                            | M3                                                        |
| File-mutation queue      | `packages/coding-agent/src/core/tools/file-mutation-queue.ts`                                | M3                                                        |
| RPC schema               | `packages/coding-agent/src/modes/rpc/rpc-types.ts`                                           | M1 (done), M5+ extend                                     |
| Session persistence      | `packages/coding-agent/src/core/session-manager.ts`                                          | M5                                                        |
| Session tree             | `packages/coding-agent/src/core/session-manager.ts`, `agent-session-runtime.ts`              | M6                                                        |
| Compaction               | `packages/coding-agent/src/core/compaction/*`                                                | M7                                                        |
| Extension types + runner | `packages/coding-agent/src/core/extensions/{types,runner,wrapper}.ts`                        | M8                                                        |
| Skills + resources       | `packages/coding-agent/src/core/{slash-commands,resource-loader,prompt-templates,skills}.ts` | M9 (vault-sourced subset done — commands, prompts, skills + sandboxed `bash` shim; extensions/themes/multi-tier pending) |
| HTML export              | `packages/coding-agent/src/core/export-html/*`                                               | M10                                                       |
| Bash executor            | `packages/coding-agent/src/core/bash-executor.ts`, `tools/bash.ts`                           | deferred                                                  |
| TUI                      | `packages/coding-agent/src/modes/interactive/`                                               | not ported (React UI replaces)                            |
| Extension loader (jiti)  | `packages/coding-agent/src/core/extensions/loader.ts`                                        | replaced with browser ESM dynamic import in a Worker (M8) |
