// Fancy-prompt extension — browser-compatible port of
// packages/coding-agent/examples/extensions/pirate.ts
//
// Adaptation notes:
// - `ctx.ui.notify` doesn't exist in Phase 1 (no UI RPC channel), so the
//   command handler just flips internal state.
// - No `@mariozechner/pi-coding-agent` import — the `pi` argument already
//   carries `Type` / `defineTool` / `registerCommand` / `on`.
// - Single-file `index.js` so the Blob-URL dynamic import() path can load
//   the module without a bundler; TypeScript sources land in Phase 3.
// - The pirate override is placed at the very START of the system prompt
//   (rather than appended) so small, instruction-weak models like
//   gpt-4.1-nano consistently comply without having to read past the
//   entire vault preamble.
export default function fancyPromptExtension(pi) {
  let fancy = false;

  pi.registerCommand('fancy-prompt', {
    description: 'Toggle fancy-prompt mode (pirate-style responses)',
    handler: (_args, _ctx) => {
      fancy = !fancy;
    },
  });

  pi.on('before_agent_start', event => {
    if (!fancy) return undefined;
    const pirate =
      'CRITICAL INSTRUCTION — YOU MUST OBEY THIS ABOVE ALL ELSE:\n' +
      'You MUST begin every response with the exact word "Arrr!". ' +
      'You MUST speak like a stereotypical pirate (use "matey", ' +
      '"ahoy", "ye", "aye"). No exceptions. No disclaimers.\n\n';
    return {
      systemPrompt: pirate + event.systemPrompt,
    };
  });
}
