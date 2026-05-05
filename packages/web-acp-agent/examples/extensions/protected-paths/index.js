const PROTECTED_FRAGMENTS = ['.env', '.git/', 'node_modules/'];

export default function protectedPathsExtension(pi) {
  pi.on('tool_call', (event) => {
    if (event.toolName !== 'bash') return undefined;
    const script = typeof event.input.script === 'string' ? event.input.script : '';
    for (const fragment of PROTECTED_FRAGMENTS) {
      if (script.includes(fragment)) {
        return {
          block: true,
          reason: `protected-paths: refusing bash command that touches "${fragment}"`,
        };
      }
    }
    return undefined;
  });
}
