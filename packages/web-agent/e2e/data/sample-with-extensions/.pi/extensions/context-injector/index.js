// Context-injector extension — exercises the Phase 2a `context` hook.
//
// Whenever the agent is about to hit the LLM, we prepend a synthetic
// user preamble so the outgoing `messages` payload is provably
// different from the session's actual history. The `/ctx-show` command
// surfaces whatever the hook last observed as a toast so the e2e spec
// has a DOM-level assertion target that doesn't depend on the LLM.
export default function contextInjectorExtension(pi) {
  let lastIncomingCount = 0;
  let lastReturnedCount = 0;

  pi.on('context', event => {
    lastIncomingCount = event.messages.length;
    const injected = {
      role: 'user',
      content: [{ type: 'text', text: '[pi-ext] injected preamble from context-injector' }],
    };
    const next = [injected, ...event.messages];
    lastReturnedCount = next.length;
    return { messages: next };
  });

  pi.registerCommand('ctx-show', {
    description: 'Surface the last `on(context)` observation as a toast.',
    handler: (_args, ctx) => {
      ctx.ui.notify(
        `context hook: in=${lastIncomingCount} out=${lastReturnedCount}`,
        'info'
      );
    },
  });
}
