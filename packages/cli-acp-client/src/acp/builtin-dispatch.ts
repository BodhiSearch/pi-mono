/**
 * Client-side dispatcher for `_meta.bodhi.builtin.action` envelopes.
 *
 * The agent doesn't perform "host actions" itself — it produces a
 * descriptor (`{ kind: 'copy' }`, `{ kind: 'mcp-add', params: { url } }`,
 * etc.) and rides it on a `session/update` notification. The host is
 * responsible for translating each kind into the right local effect:
 *
 *  - `copy`  → write the conversation transcript to the system
 *              clipboard. Terminals that forward OSC 52 (xterm,
 *              iTerm, kitty, Alacritty, recent Windows Terminal) get
 *              a real clipboard write; everything else falls back to
 *              echoing the transcript with a `Copy from above:`
 *              banner so the user can manually copy it.
 *
 *  - `mcp-add` / `mcp-remove` → mutate sqlite kv `requestedMcps`,
 *              then nudge the user to re-run `/login` so Keycloak
 *              picks up the new resource set. We don't auto-trigger
 *              the login flow because it opens a browser — better
 *              to keep the side-effect explicit.
 */

import type { AnyBodhiBuiltinAction } from '@bodhiapp/web-acp-agent';
import { canonicalizeMcpUrl } from '@bodhiapp/web-acp-agent';
import type { AppContext } from '../shell/context';
import type { AgentMessage } from './streaming-reducer';
import { KV_REQUESTED_MCPS } from '../storage/kv-keys';

export interface BuiltinActionInput {
  action: AnyBodhiBuiltinAction;
  sessionId: string | null;
  messages: AgentMessage[];
}

export function createBuiltinActionDispatcher(ctx: AppContext) {
  return async function dispatch(input: BuiltinActionInput): Promise<void> {
    switch (input.action.kind) {
      case 'copy':
        return handleCopy(ctx, input);
      case 'mcp-add':
        return handleMcpAdd(ctx, input.action.params.url);
      case 'mcp-remove':
        return handleMcpRemove(ctx, input.action.params.url);
    }
  };
}

async function handleCopy(ctx: AppContext, input: BuiltinActionInput): Promise<void> {
  const sessionId = input.sessionId;
  let messages = input.messages;
  if (sessionId) {
    try {
      const snapshot = await ctx.client.getSession(sessionId);
      if (Array.isArray(snapshot.messages)) {
        messages = snapshot.messages as AgentMessage[];
      }
    } catch {
      // Fall back to in-memory messages if the snapshot fetch fails.
    }
  }
  const transcript = renderConversationMarkdown(messages);
  if (!transcript) {
    ctx.renderer.emit({ kind: 'info', text: 'Nothing to copy yet.' });
    return;
  }
  const stdoutLike = process.stdout as NodeJS.WriteStream & { isTTY?: boolean };
  if (terminalSupportsOsc52(stdoutLike)) {
    const encoded = Buffer.from(transcript, 'utf8').toString('base64');
    stdoutLike.write(`\x1b]52;c;${encoded}\x07`);
    ctx.renderer.emit({
      kind: 'system',
      text: 'Conversation copied to clipboard via OSC 52. If your terminal does not honour OSC 52 sequences, run /copy from a terminal that does (e.g. iTerm2, kitty) or copy manually from above.',
    });
    return;
  }
  ctx.renderer.emit({
    kind: 'system',
    text: 'Copy from above:\n' + transcript,
  });
}

async function handleMcpAdd(ctx: AppContext, rawUrl: string): Promise<void> {
  let url: string;
  try {
    url = canonicalizeMcpUrl(rawUrl);
  } catch (err) {
    ctx.renderer.emit({
      kind: 'error',
      text: `mcp-add: invalid URL ${rawUrl}: ${err instanceof Error ? err.message : String(err)}`,
    });
    return;
  }
  const current = ctx.host.kv.get<string[]>(KV_REQUESTED_MCPS) ?? [];
  if (current.includes(url)) return;
  const next = [...current, url];
  ctx.host.kv.set(KV_REQUESTED_MCPS, next);
  ctx.requestedMcps = next;
  ctx.renderer.emit({
    kind: 'info',
    text: `Added MCP wishlist entry: ${url}. Run /login to refresh the access-request scope.`,
  });
}

async function handleMcpRemove(ctx: AppContext, rawUrl: string): Promise<void> {
  let url: string;
  try {
    url = canonicalizeMcpUrl(rawUrl);
  } catch {
    url = rawUrl;
  }
  const current = ctx.host.kv.get<string[]>(KV_REQUESTED_MCPS) ?? [];
  if (!current.includes(url)) return;
  const next = current.filter(u => u !== url);
  ctx.host.kv.set(KV_REQUESTED_MCPS, next);
  ctx.requestedMcps = next;
  ctx.renderer.emit({
    kind: 'info',
    text: `Removed MCP wishlist entry: ${url}. Run /login to refresh.`,
  });
}

function terminalSupportsOsc52(stdout: NodeJS.WriteStream & { isTTY?: boolean }): boolean {
  if (!stdout.isTTY) return false;
  const term = process.env.TERM ?? '';
  // Known terminals that don't forward OSC 52 by default. The list
  // is conservative — when in doubt we still write OSC 52 because
  // unsupported terminals just print garbage glyphs (which we then
  // mitigate by also printing the transcript on stderr in a future
  // iteration).
  if (term === 'dumb') return false;
  if (process.env.CI) return false;
  return true;
}

/**
 * Build a simple markdown transcript suitable for clipboard copy.
 * Filters out non-conversational entries (`toolResult`, anything
 * marked `_builtin`, empty messages). Mirror of
 * `packages/web-acp/src/lib/builtin-format.ts`.
 */
export function renderConversationMarkdown(messages: AgentMessage[]): string {
  const blocks: string[] = [];
  for (const msg of messages) {
    if (msg._builtin) continue;
    if (msg.role === 'toolResult') continue;
    const text = extractText(msg).trim();
    if (!text) continue;
    if (msg.role === 'user') blocks.push(`**You:**\n\n${text}`);
    else if (msg.role === 'assistant') blocks.push(`**Assistant:**\n\n${text}`);
  }
  return blocks.join('\n\n');
}

function extractText(msg: AgentMessage): string {
  const content = msg.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const part of content) {
    if (
      part &&
      typeof part === 'object' &&
      'type' in part &&
      (part as { type: unknown }).type === 'text' &&
      'text' in part &&
      typeof (part as { text: unknown }).text === 'string'
    ) {
      parts.push((part as { text: string }).text);
    }
  }
  return parts.join('');
}
