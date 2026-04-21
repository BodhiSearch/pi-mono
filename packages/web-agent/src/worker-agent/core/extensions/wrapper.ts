/**
 * Wrap extension-registered tools into pi-agent-core `AgentTool`
 * instances.
 *
 * The agent loop only knows about `AgentTool` (name + description +
 * parameters + execute). Extension authors hand us `ToolDefinition` —
 * an execute closure that takes an `ExtensionContext` argument the
 * agent loop cannot produce. The wrapper closes over a context
 * supplier (so each invocation sees live isIdle/cwd) and adapts
 * pi-agent-core's five-argument `execute(id, params, signal, onUpdate)`
 * signature to the six-argument extension signature.
 *
 * Mirrors `packages/coding-agent/src/core/extensions/wrapper.ts` but
 * simpler: no `label` / `renderCall` / `renderResult` surface to carry
 * (the worker has no TUI), and the extension-runner's error surface
 * catches throws at the `emit` boundaries rather than here.
 */

import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import type { Static, TSchema } from '@sinclair/typebox';
import type { ContextSupplier, RegisteredTool, ToolDefinition } from './types';

/**
 * Produce an `AgentTool` suitable for `session.setTools(...)` from a
 * single registered extension tool. `getContext` is invoked per call
 * so `isIdle` / `cwd` reflect the current session state, not the
 * state at registration time.
 */
export function wrapRegisteredTool(
  registered: RegisteredTool,
  getContext: ContextSupplier
): AgentTool {
  const def = registered.definition as ToolDefinition<TSchema, unknown>;
  const adapted: AgentTool = {
    name: def.name,
    description: def.description,
    parameters: def.parameters,
    label: def.name,
    ...(def.prepareArguments ? { prepareArguments: def.prepareArguments } : {}),
    ...(def.executionMode ? { executionMode: def.executionMode } : {}),
    async execute(toolCallId, params, signal, onUpdate) {
      const ctx = getContext();
      const result = await def.execute(
        toolCallId,
        params as Static<TSchema>,
        signal,
        onUpdate,
        ctx
      );
      return result as AgentToolResult<unknown>;
    },
  };
  return adapted;
}

/** Convenience: wrap a whole array. Preserves input order. */
export function wrapRegisteredTools(
  registered: RegisteredTool[],
  getContext: ContextSupplier
): AgentTool[] {
  return registered.map(r => wrapRegisteredTool(r, getContext));
}
