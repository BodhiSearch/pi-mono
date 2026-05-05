const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9]{8,}/g,
  /api[_-]?key\s*[:=]\s*[A-Za-z0-9_-]{8,}/gi,
];

export default function redactSecretsExtension(pi) {
  pi.on('tool_result', (event) => {
    if (!Array.isArray(event.content)) return undefined;
    let mutated = false;
    const nextContent = event.content.map((block) => {
      if (block && block.type === 'text' && typeof block.text === 'string') {
        const redacted = redact(block.text);
        if (redacted !== block.text) {
          mutated = true;
          return { ...block, text: redacted };
        }
      }
      return block;
    });
    if (!mutated) return undefined;
    return { content: nextContent };
  });
}

function redact(input) {
  let out = input;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, '[REDACTED]');
  }
  return out;
}
