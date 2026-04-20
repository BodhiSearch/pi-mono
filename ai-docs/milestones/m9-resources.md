# M9 — Resources (commands, prompts, themes)

**Status:** planned. Test seam: vitest.

**Scope preview.**
- Resource loader pattern: extensions can contribute slash commands, prompt templates, themes by declaring them in their manifest or calling `registerCommand`/`registerPromptTemplate`/`registerTheme` at load.
- Slash-command registry: builtin commands + extension-provided commands. `/command-name args...` from the chat input triggers the command handler.
- Prompt templates with frontmatter-style metadata (scope, variables, description) like coding-agent's but as ESM not YAML-in-filesystem.
- Theme registration optional for v1 (UI can ship with two built-in themes and defer custom themes).

**Coding-agent references.** `packages/coding-agent/src/core/{slash-commands,resource-loader,prompt-templates,skills}.ts`.

**Gate.** vitest covering: builtin `/help` works; extension-registered `/echo-extension` works; command with autocomplete suggestions.
