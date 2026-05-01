/**
 * Default prompt handler — invoked for every plain (non-slash) input
 * line. Ensures an active session exists, pushes the prompt through ACP,
 * and emits assistant output via the renderer.
 *
 * Streaming model: ACP's `agent_message_chunk` payload carries a *delta*
 * (just the new text emitted by the LLM since the previous chunk) — see
 * `web-acp-agent/src/acp/engine/prompt-driver.ts` (`text.slice(cursor.
 * emittedLength)`). Renderers, on the other hand, use `setText` for any
 * emit that reuses an `id` — so emitting raw deltas would cause each
 * fragment to *overwrite* the previous one in the TUI (you'd see only
 * the last token, e.g. "😊"). We therefore accumulate the deltas here
 * and emit the cumulative assistant text under a fresh per-turn id, so
 * the renderer's replace-semantics produces the expected "growing
 * line" effect and one assistant slot per question.
 */

import type { SessionNotification } from '@agentclientprotocol/sdk';
import type { AppContext } from '../shell/context';

interface AssistantStreamState {
  /** Stable id we hand to the renderer to identify this turn's slot. */
  fallbackId: string;
  /**
   * Per-LLM-message accumulator. Keys are either the agent-supplied
   * `messageId` (when present) or `fallbackId` for chunks that don't
   * carry one. Most LLM streams emit a single message id per turn, but
   * some providers split the response across multiple ids — each gets
   * its own line.
   */
  buffers: Map<string, string>;
}

let promptCounter = 0;

export async function handlePrompt(ctx: AppContext, text: string): Promise<void> {
  if (ctx.status.kind !== 'authenticated') {
    ctx.renderer.emit({
      kind: 'error',
      text: 'Not authenticated. Run /host <url> then /login first.',
    });
    return;
  }
  if (!ctx.modelId) {
    ctx.renderer.emit({
      kind: 'error',
      text: 'No model selected. Run /models then /model <id>.',
    });
    return;
  }

  await ensureSession(ctx);
  if (!ctx.sessionId) return;

  ctx.renderer.emit({ kind: 'user', text });

  const stream: AssistantStreamState = {
    fallbackId: `assistant-${++promptCounter}`,
    buffers: new Map(),
  };

  const updateUnsubscribe = ctx.client.onSessionUpdate(notification => {
    renderUpdate(ctx, notification, stream);
  });
  try {
    await ctx.client.prompt(ctx.sessionId, text, ctx.modelId);
  } finally {
    updateUnsubscribe();
  }
}

async function ensureSession(ctx: AppContext): Promise<void> {
  if (ctx.sessionId) return;
  const result = await ctx.client.newSession(ctx.cwd, ctx.composedMcpServers);
  ctx.sessionId = result.sessionId;
}

function renderUpdate(
  ctx: AppContext,
  notification: SessionNotification,
  stream: AssistantStreamState
): void {
  // ACP `session/update` carries a polymorphic update on `update`; here
  // we surface only the most informative kinds for v0. The TUI can
  // later inspect the discriminator and render dedicated widgets.
  const update = (notification as { update?: { sessionUpdate?: string } }).update;
  if (!update?.sessionUpdate) return;
  switch (update.sessionUpdate) {
    case 'agent_message_chunk': {
      const chunk = update as unknown as {
        content?: { type?: string; text?: string };
        messageId?: string;
      };
      const delta = chunk.content?.text;
      if (!delta) return;
      const bufferKey = chunk.messageId ?? stream.fallbackId;
      const renderId = chunk.messageId
        ? `${stream.fallbackId}:${chunk.messageId}`
        : stream.fallbackId;
      const accumulated = (stream.buffers.get(bufferKey) ?? '') + delta;
      stream.buffers.set(bufferKey, accumulated);
      ctx.renderer.emit({
        id: renderId,
        kind: 'assistant',
        text: accumulated,
      });
      return;
    }
    case 'tool_call':
    case 'tool_call_update': {
      const tc = update as unknown as { title?: string; status?: string; toolCallId?: string };
      if (tc.title) {
        ctx.renderer.emit({
          id: tc.toolCallId ?? `tool-${tc.title}`,
          kind: 'tool',
          text: `[${tc.status ?? 'pending'}] ${tc.title}`,
        });
      }
      return;
    }
    case 'plan': {
      // Skip noisy plan updates in line mode; TUI can render them later.
      return;
    }
    default:
      return;
  }
}
