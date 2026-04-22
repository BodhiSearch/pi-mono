// Asker extension — drives every interactive `pi.ui.*` call so the
// e2e spec has a deterministic way to open a select / confirm / input
// dialog and verify the round-trip back to the extension.
//
// Each command captures the answer in a closure and surfaces it
// through a follow-up toast; the spec asserts on the toast content to
// prove the worker-side promise resolved with the user's choice.
export default function askerExtension(pi) {
  pi.registerCommand('ask-select', {
    description: 'Open a select dialog and toast the chosen value.',
    handler: async (_args, ctx) => {
      ctx.ui.setStatus('awaiting select…');
      const choice = await ctx.ui.select('Pick a colour', [
        { label: 'Red', value: 'red' },
        { label: 'Green', value: 'green' },
        { label: 'Blue', value: 'blue' },
      ]);
      ctx.ui.setStatus(null);
      ctx.ui.notify(`asker: select returned ${choice ?? 'cancelled'}`, 'info');
    },
  });

  pi.registerCommand('ask-confirm', {
    description: 'Open a confirm dialog and toast the result.',
    handler: async (_args, ctx) => {
      const ok = await ctx.ui.confirm('Proceed?', 'This is a test confirm.');
      ctx.ui.notify(`asker: confirm returned ${ok}`, ok ? 'info' : 'warning');
    },
  });

  pi.registerCommand('ask-input', {
    description: 'Open an input dialog and toast the echoed value.',
    handler: async (_args, ctx) => {
      const value = await ctx.ui.input('Your name?', 'type here');
      ctx.ui.notify(`asker: input returned ${value ?? 'cancelled'}`, 'info');
    },
  });

  pi.registerCommand('ask-status', {
    description: 'Set a persistent status chip (pass `clear` to remove it).',
    handler: (args, ctx) => {
      const trimmed = args.trim();
      if (trimmed === 'clear' || trimmed === '') {
        ctx.ui.setStatus(null);
      } else {
        ctx.ui.setStatus(trimmed);
      }
    },
  });
}
