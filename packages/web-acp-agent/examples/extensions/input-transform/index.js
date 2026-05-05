const QUICK_PREFIX = '?quick ';

export default function inputTransformExtension(pi) {
  pi.on('input', (event) => {
    if (event.source !== 'user') return undefined;
    if (!event.text.startsWith(QUICK_PREFIX)) return undefined;
    const query = event.text.slice(QUICK_PREFIX.length).trim();
    if (!query) return undefined;
    return {
      action: 'transform',
      text: `Respond briefly in one short sentence and prefix the reply with "QUICK:". Question: ${query}`,
    };
  });
}
