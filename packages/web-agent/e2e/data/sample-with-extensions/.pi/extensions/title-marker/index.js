// Title-marker extension — exercises `pi.ui.setTitle`.
//
// Sets a header title whenever a session finishes (re)loading so the
// spec can see the slot populate on mount / reload / switch / new.
// Also exposes `/title-set` and `/title-clear` slash commands for
// explicit test-driven mutations that don't rely on LLM turns.
export default function titleMarkerExtension(pi) {
  let lastReason = 'mount';

  pi.on('session_loaded', event => {
    lastReason = event.reason;
    pi.ui.setTitle(`title-marker: ${event.reason}`);
  });

  // Observer-only; ensures the title persists after a message finishes
  // even if an extension clears it during the turn (regression guard).
  pi.on('message_end', () => {
    pi.ui.setTitle(`title-marker: ${lastReason} (idle)`);
  });

  pi.registerCommand('title-set', {
    description: 'Set the extension title to the supplied text.',
    handler: (args, ctx) => {
      const trimmed = args.trim();
      ctx.ui.setTitle(trimmed.length === 0 ? 'title-marker: manual' : trimmed);
    },
  });

  pi.registerCommand('title-clear', {
    description: 'Clear the extension-contributed title.',
    handler: (_args, ctx) => {
      ctx.ui.setTitle(null);
    },
  });
}
