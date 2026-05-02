/**
 * Default prompt handler — invoked for every plain (non-slash) input
 * line, and for `/<cmd>` lines that fall through the shell registry
 * (vault commands, agent built-ins).
 *
 * The session/update subscription is owned by the long-lived
 * `StreamController` (subscribed once at boot from `bootstrap.ts`).
 * This handler only:
 *   1. validates auth + model gate (skipping the model check for
 *      agent built-ins that bypass the LLM),
 *   2. ensures a session exists,
 *   3. dispatches `turn-start`, awaits the prompt RPC, then
 *      dispatches `turn-end` with the captured streaming message.
 *
 * Tool / chunk / mcp lifecycle rendering all flows through the
 * controller, so this handler stays stateless across turns.
 */

import { isBuiltinName } from '@bodhiapp/web-acp-agent';
import type { AppContext } from '../shell/context';
import { detectBuiltinTag, userMessage, withBuiltinTag } from '../acp/streaming-reducer';
import { buildSessionMeta } from '../mcp/catalog';

export async function handlePrompt(ctx: AppContext, text: string): Promise<void> {
  if (ctx.status.kind !== 'authenticated') {
    ctx.renderer.emit({
      kind: 'error',
      text: 'Not authenticated. Run /host <url> then /login first.',
    });
    return;
  }

  const builtinTag = detectBuiltinTag(text);
  if (!builtinTag && !ctx.modelId) {
    ctx.renderer.emit({
      kind: 'error',
      text: 'No model selected. Run /models then /model <id>.',
    });
    return;
  }

  await ensureSession(ctx);
  if (!ctx.sessionId) return;

  ctx.renderer.emit({ kind: 'user', text });

  const userMsg = builtinTag ? withBuiltinTag(userMessage(text), builtinTag) : userMessage(text);
  ctx.stream.dispatch({ type: 'turn-start', userMessage: userMsg });

  try {
    const response = await ctx.client.prompt(ctx.sessionId, text, ctx.modelId ?? '');
    const finalMessage = ctx.stream.currentStreamingMessage();
    ctx.stream.dispatch({
      type: 'turn-end',
      stopReason: response.stopReason ?? 'end_turn',
      finalMessage,
    });
  } catch (err) {
    ctx.stream.dispatch({ type: 'turn-end', stopReason: 'error' });
    throw err;
  }
}

async function ensureSession(ctx: AppContext): Promise<void> {
  if (ctx.sessionId) return;
  const sessionMeta = buildSessionMeta(ctx);
  const result = await ctx.client.newSession(ctx.cwd, ctx.composedMcpServers, sessionMeta);
  ctx.sessionId = result.sessionId;
}

// Re-export for the dispatcher's local builtin-name check.
export { isBuiltinName };
