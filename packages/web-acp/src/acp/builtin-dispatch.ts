import { toast } from 'sonner';
import type { AgentMessage } from '@mariozechner/pi-agent-core';
import type { AnyBodhiBuiltinAction } from '@/acp/index';
import { renderConversationMarkdown } from '@/lib/builtin-format';
import { addRequestedMcp, removeRequestedMcp } from '@/mcp/requested-mcps-store';

/**
 * Re-trigger Bodhi login with the updated requested-MCPs list. The
 * concrete implementation closes over `useBodhi`'s `login`/`logout`
 * pair and is wired in the host hook; pulling it out as an injection
 * keeps `dispatchBuiltinAction` testable without React.
 */
export type LoginTrigger = (urls: string[]) => Promise<void>;

/**
 * Render a conversation transcript to clipboard markdown.
 */
export async function dispatchCopyAction(messages: AgentMessage[]): Promise<void> {
  const markdown = renderConversationMarkdown(messages);
  if (!markdown) {
    toast.error('Nothing to copy yet');
    return;
  }
  try {
    await navigator.clipboard.writeText(markdown);
    toast.success('Copied conversation to clipboard');
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Clipboard write failed';
    toast.error(`Copy failed: ${message}`);
  }
}

/**
 * Client-side dispatcher for the optional `action` attached to a
 * built-in's reply. Switches on the discriminated union from
 * `acp/index.ts` so the compiler enforces per-kind payload shapes.
 *
 * `mcp-add` / `mcp-remove`: delegate to the IDB store, then re-trigger
 * `auth.login` with the updated list via the injected `LoginTrigger`.
 * The list-mutation helpers are idempotent — a duplicate add or a
 * missing remove surface as a toast and skip the redirect.
 */
export async function dispatchBuiltinAction(
  action: AnyBodhiBuiltinAction,
  messages: AgentMessage[],
  triggerLogin: LoginTrigger
): Promise<void> {
  switch (action.kind) {
    case 'copy':
      await dispatchCopyAction(messages);
      return;
    case 'mcp-add': {
      const { list, added, canonical } = await addRequestedMcp(action.params.url);
      if (canonical === null) {
        toast.error(`Invalid URL: ${action.params.url}`);
        return;
      }
      if (!added) {
        toast.info(`\`${canonical}\` is already requested.`);
        return;
      }
      await triggerLogin(list);
      return;
    }
    case 'mcp-remove': {
      const { list, removed, canonical } = await removeRequestedMcp(action.params.url);
      if (canonical === null) {
        toast.error(`Invalid URL: ${action.params.url}`);
        return;
      }
      if (!removed) {
        toast.info(`\`${canonical}\` was not in your requested list.`);
        return;
      }
      await triggerLogin(list);
      return;
    }
  }
}
