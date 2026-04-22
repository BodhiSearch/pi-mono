// Notifier extension — exercises Phase 2a observer hooks + `pi.ui.notify`.
//
// Counts how many `turn_start` / `message_end` events fire and surfaces
// the running total via `/notify-stats`. Also registers `/notify-test`
// so the e2e spec can assert toast appearance without needing the LLM
// to drive a turn.
export default function notifierExtension(pi) {
  let turnStarts = 0;
  let messageEnds = 0;

  pi.on('turn_start', () => {
    turnStarts += 1;
  });
  pi.on('message_end', () => {
    messageEnds += 1;
  });

  pi.registerCommand('notify-test', {
    description: 'Emit an info / warning / error toast through the UI channel.',
    handler: (args, ctx) => {
      const kind = args.trim() || 'info';
      const mapped = kind === 'warning' || kind === 'error' ? kind : 'info';
      ctx.ui.notify(`notifier: ${mapped} message`, mapped);
    },
  });

  pi.registerCommand('notify-stats', {
    description: 'Surface observer-hook counts as a toast.',
    handler: (_args, ctx) => {
      ctx.ui.notify(
        `notifier: turn_start=${turnStarts} message_end=${messageEnds}`,
        'info'
      );
    },
  });
}
