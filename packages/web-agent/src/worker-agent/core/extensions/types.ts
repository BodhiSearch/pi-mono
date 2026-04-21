/**
 * Minimal extension types for Phase 1.
 *
 * Phase 5 expands this to mirror the full `coding-agent/core/extensions`
 * shape (ui context, command/shortcut registration, compact lifecycle,
 * provider registration). Keep only what the registry stub needs for now.
 */

import type { AgentEvent, AgentTool } from '@mariozechner/pi-agent-core';

export interface ExtensionContext {
  /** True when the agent is not currently streaming. */
  isIdle(): boolean;
  /** Abort the current streaming run. */
  abort(): void;
}

export type ExtensionEventHandler<E extends AgentEvent = AgentEvent> = (
  event: E,
  ctx: ExtensionContext
) => void | Promise<void>;

export interface ExtensionAPI {
  on<T extends AgentEvent['type']>(
    event: T,
    handler: ExtensionEventHandler<Extract<AgentEvent, { type: T }>>
  ): void;
  registerTool(tool: AgentTool): void;
}

export type ExtensionFactory = (api: ExtensionAPI) => void | Promise<void>;

export interface ExtensionManifest {
  name: string;
  version: string;
  description?: string;
}

export interface Extension extends ExtensionManifest {
  factory: ExtensionFactory;
}
