/**
 * Filesystem tool barrel + one-call factory for vault tools.
 *
 * Usage in a host (typically the React hook):
 *   const tools = createVaultTools(createZenfsVaultOperations());
 *   session.setTools(tools);
 */

import type { AgentTool } from '@mariozechner/pi-agent-core';
import type { VaultOperations } from '../../fs/zenfs-operations';
import { createEditTool } from './edit';
import { createGlobTool } from './glob';
import { createGrepTool } from './grep';
import { createLsTool } from './ls';
import { createReadTool } from './read';
import { createWriteTool } from './write';

export { createReadTool } from './read';
export type { ReadToolInput, ReadToolDetails } from './read';
export { createWriteTool } from './write';
export type { WriteToolInput } from './write';
export { createEditTool } from './edit';
export type { EditToolInput, EditToolDetails } from './edit';
export { createLsTool } from './ls';
export type { LsToolInput, LsToolDetails } from './ls';
export { createGlobTool } from './glob';
export type { GlobToolInput, GlobToolDetails } from './glob';
export { createGrepTool } from './grep';
export type { GrepToolInput, GrepToolDetails } from './grep';
export { withFileMutationQueue } from './file-mutation-queue';

export interface CreateVaultToolsOptions {
  /** Directory against which relative paths resolve. Defaults to /vault. */
  cwd?: string;
}

/**
 * Build the six filesystem tools wired against the given vault operations.
 *
 * The caller is responsible for ensuring the vault is mounted before an
 * agent turn fires a tool — tools will surface the underlying ZenFS
 * ENOENT / ENOTDIR errors otherwise.
 */
export function createVaultTools(
  ops: VaultOperations,
  options: CreateVaultToolsOptions = {}
): AgentTool[] {
  const { cwd } = options;
  // Each createXxxTool returns a tightly-typed AgentTool<typeof schema, ToolDetails>;
  // the `AgentTool[]` array is the broader union pi-agent-core accepts. The cast
  // collapses variance mismatch on the contravariant `params` position in
  // `execute` — the narrower tools strictly accept the schema-validated shape,
  // but the broader interface takes `unknown`. Runtime behaviour is unchanged
  // because the agent loop validates against `parameters` before invoking.
  return [
    createReadTool({ operations: ops.read, cwd }),
    createWriteTool({ operations: ops.write, cwd }),
    createEditTool({ operations: ops.edit, cwd }),
    createLsTool({ operations: ops.ls, cwd }),
    createGlobTool({ operations: ops.glob, cwd }),
    createGrepTool({ operations: ops.grep, cwd }),
  ] as unknown as AgentTool[];
}
