// Thrower extension — registers a before_agent_start handler that
// always throws. Verifies the ExtensionRunner's per-extension error
// isolation: the run should proceed normally, and an extension_error
// RPC event should surface on the main thread.
export default function throwerExtension(pi) {
  pi.on('before_agent_start', _event => {
    throw new Error('intentional thrower failure');
  });
}
