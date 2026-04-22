// Tool-gate extension — exercises the Phase 2a `tool_call` hook.
//
// Registers a companion tool (`gated`) so the test can invoke it via
// the `/gate-run` extension command without depending on the LLM. The
// `tool_call` handler mutates the tool input in place (adds a `tag`
// field) and optionally short-circuits execution by returning
// `{ block: true }` when the input carries `block: true`.
//
// The hook outcome is surfaced back through `pi.ui.notify` so the e2e
// spec can observe both branches (mutated vs blocked) from the DOM.
export default function toolGateExtension(pi) {
  const gated = pi.defineTool({
    name: 'gated',
    description: 'Echoes a tagged payload after passing through the tool_call hook.',
    parameters: pi.Type.Object({
      payload: pi.Type.String(),
      block: pi.Type.Optional(pi.Type.Boolean()),
      tag: pi.Type.Optional(pi.Type.String()),
    }),
    async execute(_id, params) {
      return {
        content: [
          { type: 'text', text: `gated:${params.payload}:${params.tag ?? 'untagged'}` },
        ],
      };
    },
  });
  pi.registerTool(gated);

  pi.on('tool_call', event => {
    if (event.toolName !== 'gated') return undefined;
    // In-place mutation — the executor sees the same reference.
    event.input.tag = 'mutated';
    if (event.input.block === true) {
      return { block: true, reason: 'tool-gate: blocked by policy' };
    }
    return undefined;
  });

  pi.registerCommand('gate-run', {
    description: 'Invoke the gated tool via the extension channel (bypasses the LLM).',
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      const shouldBlock = trimmed === 'block';
      const payload = shouldBlock ? 'blocked-payload' : trimmed || 'hello';
      try {
        const result = await gated.execute('ext-cmd', {
          payload,
          block: shouldBlock ? true : undefined,
        });
        const text = result.content.map(c => c.text).join(' ');
        ctx.ui.notify(`gated tool ran: ${text}`, 'info');
      } catch (err) {
        ctx.ui.notify(
          `gated tool blocked: ${err instanceof Error ? err.message : String(err)}`,
          'warning'
        );
      }
    },
  });
}
