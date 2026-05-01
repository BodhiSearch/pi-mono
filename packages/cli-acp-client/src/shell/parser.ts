/**
 * Splits a single input line into either a slash-command invocation or a
 * regular prompt. Whitespace-tolerant; arguments are split by spaces but
 * preserve quoted phrases so `/mcp add "https://example.com/mcp"` works.
 */

export type ParsedInput =
  | { kind: 'command'; name: string; args: string[]; raw: string }
  | { kind: 'prompt'; text: string }
  | { kind: 'empty' };

export function parseInputLine(line: string): ParsedInput {
  const trimmed = line.trim();
  if (trimmed.length === 0) return { kind: 'empty' };
  if (!trimmed.startsWith('/')) return { kind: 'prompt', text: line };
  // First token after `/` is the command name; rest are args.
  const after = trimmed.slice(1);
  const tokens = tokenize(after);
  if (tokens.length === 0) return { kind: 'empty' };
  const [name, ...args] = tokens;
  return { kind: 'command', name, args, raw: trimmed };
}

function tokenize(text: string): string[] {
  const out: string[] = [];
  let buf = '';
  let quote: '"' | "'" | undefined;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) {
        quote = undefined;
        continue;
      }
      if (c === '\\' && i + 1 < text.length) {
        buf += text[++i];
        continue;
      }
      buf += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c as '"' | "'";
      continue;
    }
    if (/\s/.test(c)) {
      if (buf.length > 0) {
        out.push(buf);
        buf = '';
      }
      continue;
    }
    buf += c;
  }
  if (buf.length > 0) out.push(buf);
  return out;
}
