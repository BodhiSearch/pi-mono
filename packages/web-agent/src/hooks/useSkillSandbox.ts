/**
 * React glue around `SandboxHost` + `BashSkillService`.
 *
 * Responsibilities:
 * - Construct the iframe-backed sandbox once per mount and tear it
 *   down on unmount (HMR + React.StrictMode safe via lazy `useState`).
 * - Expose a `{ descriptor, handler }` pair shaped like
 *   `useMcpAgentTools` so the host can concatenate both sources and
 *   pass them straight through to `useAgent`.
 *
 * The descriptor is the `bash` shim; the handler routes every
 * `bash` invocation to `BashSkillService.invoke`.
 */

import { useEffect, useMemo, useState } from 'react';
import { BASH_SKILL_TOOL_DESCRIPTOR, BashSkillService, SandboxHost } from '@/sandbox';
import type { McpToolDescriptor, ToolCallHandler } from '@/worker-agent';

export interface UseSkillSandboxResult {
  descriptor: McpToolDescriptor;
  handler: ToolCallHandler;
  /** Exposed for tests; production callers don't need it. */
  sandbox: SandboxHost;
}

export function useSkillSandbox(): UseSkillSandboxResult {
  // Lazy useState initializer fires exactly once per component
  // instance — avoids the "refs during render" ESLint warning we'd
  // get from the useRef-null-check pattern, and it's React-approved
  // for expensive singletons. We dispose on unmount.
  const [sandbox] = useState<SandboxHost>(() => new SandboxHost());

  const service = useMemo(() => new BashSkillService({ sandbox }), [sandbox]);

  useEffect(() => {
    return () => {
      sandbox.dispose();
    };
  }, [sandbox]);

  const handler = useMemo<ToolCallHandler>(() => {
    return async (toolName, args) => {
      if (toolName !== BASH_SKILL_TOOL_DESCRIPTOR.name) {
        throw new Error(`useSkillSandbox: unexpected tool ${toolName}`);
      }
      return service.invoke(args);
    };
  }, [service]);

  return {
    descriptor: BASH_SKILL_TOOL_DESCRIPTOR,
    handler,
    sandbox,
  };
}
