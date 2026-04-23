// Hello-tool extension — browser-compatible port of
// packages/coding-agent/examples/extensions/hello.ts
//
// Adaptation notes:
// - Uses `pi.Type` + `pi.defineTool` instead of importing
//   `@mariozechner/pi-ai` and `@mariozechner/pi-coding-agent`. The
//   worker has no bundler to resolve those specifiers for extension
//   code loaded at runtime.
// - `label` is omitted (not part of the Phase 1 `ToolDefinition`
//   surface — no TUI to render into).
export default function helloToolExtension(pi) {
  const helloTool = pi.defineTool({
    name: 'hello',
    description: 'A simple greeting tool',
    parameters: pi.Type.Object({
      name: pi.Type.String({ description: 'Name to greet' }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      return {
        content: [{ type: 'text', text: `Hello, ${params.name}!` }],
        details: { greeted: params.name },
      };
    },
  });

  pi.registerTool(helloTool);
}
