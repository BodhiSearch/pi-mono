// Reload-observer extension — exercises the Phase 2a `session_loaded`
// hook, which fires only from the `/reload` command path.
//
// Every fire increments a counter; the counter is surfaced via
// `/reload-count` so the e2e spec can assert the hook was dispatched
// without relying on the LLM.
export default function reloadObserverExtension(pi) {
  let reloadCount = 0;

  pi.on('session_loaded', event => {
    if (event.reason !== 'reload') return;
    reloadCount += 1;
  });

  pi.registerCommand('reload-count', {
    description: 'Surface the number of `/reload`s observed as a toast.',
    handler: (_args, ctx) => {
      ctx.ui.notify(`reload-observer: count=${reloadCount}`, 'info');
    },
  });
}
