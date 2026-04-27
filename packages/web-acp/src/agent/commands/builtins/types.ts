import type { AgentMessage } from '@mariozechner/pi-agent-core';
import type { AvailableCommand } from '@agentclientprotocol/sdk';

/**
 * Open-ended discriminator for client-side actions a built-in can
 * delegate to (e.g. `/copy` → clipboard write). The client builds the
 * actual payload from its own state at dispatch time, so the wire and
 * persisted record stay minimal: just a `kind` tag.
 *
 * Future kinds (`'share'`, `'export-html'`, `'feedback'`, …) slot in
 * by adding a string literal here without changing the envelope.
 */
export type BuiltinActionKind = 'copy';

export interface BuiltinAction {
  kind: BuiltinActionKind;
}

/**
 * Worker-side context fed to every built-in handler. Built from
 * `AcpAgentAdapter` state at the moment a `/cmd` invocation arrives.
 * Handlers must treat the snapshot as immutable.
 */
export interface BuiltinHandlerCtx {
  sessionId: string;
  modelId: string | null;
  serverUrl: string | null;
  sessionStats: { turnCount: number; messageCount: number };
  mcpServersConnected: string[];
  /** Built-ins + vault commands, the same list advertised to the client. */
  advertisedCommands: AvailableCommand[];
  /** LLM-visible message history. Built-ins are absent by construction. */
  inlineMessages: AgentMessage[];
  /** Build-time string surfaced via Vite's `define`. */
  buildVersion: string;
  /** Build-time string surfaced via Vite's `define`. */
  acpSdkVersion: string;
}

export interface BuiltinResult {
  replyText: string;
  action?: BuiltinAction;
}

export interface BuiltinCommand {
  name: string;
  description: string;
  inputHint?: string;
  handler: (args: string, ctx: BuiltinHandlerCtx) => BuiltinResult | Promise<BuiltinResult>;
}
