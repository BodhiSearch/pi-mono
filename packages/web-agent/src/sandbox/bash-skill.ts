/**
 * Main-thread `bash` shim that only routes JS skill invocations to
 * the sandbox.
 *
 * Coding-agent skills call scripts through the real `bash` tool
 * (`node path/to/script.js` or `./script.js`). Web-agent has neither
 * a shell nor a Node runtime, so we expose a tool with the same
 * `bash` name/schema but a strict parser: only `node <path>.js` /
 * `<path>.js` / `./<path>.js` forms pointing at files **inside**
 * `<vaultMount>/.pi/skills/` are accepted. Everything else is
 * rejected as an `isError` tool result so the LLM sees a clear
 * message and can retry with a different approach.
 *
 * The service is instantiated once on the main thread and its
 * `invoke()` method is wired into the RPC `tool_call_request`
 * pipeline (see `packages/web-agent/src/providers/` integration).
 * The worker side only sees an MCP descriptor — the real
 * implementation lives here where we have access to the DOM-backed
 * `SandboxHost` and the main-thread vault port.
 */

import { fs } from '../worker-agent/fs/zenfs-provider';
import type { McpToolDescriptor } from '../worker-agent/rpc/rpc-types';
import { buildDefaultCapabilityHandler } from './capabilities';
import type { SandboxHost } from './SandboxHost';
import type { SandboxRunResult } from './types';

/**
 * Shape returned to the worker's MCP-proxy `execute` stub.
 * `buildMcpProxyTool` in `worker-host.ts` forwards `{ content, ... }`
 * verbatim; `isError` is preserved for tool-result rendering in the
 * `ToolCallMessage` component.
 */
export interface BashSkillToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

/** Segment every skill script must sit beneath (relative to vault mount). */
const SKILLS_DIR_SEGMENT = '.pi/skills';

/**
 * MCP descriptor for the `bash` shim. The schema mirrors coding-agent's
 * bash tool (`command: string, cwd?: string`) so skills authored for
 * coding-agent can call it verbatim.
 */
export const BASH_SKILL_TOOL_DESCRIPTOR: McpToolDescriptor = {
  name: 'bash',
  description:
    'Run a skill script in the sandboxed JavaScript runtime. Only `node <path>.js [args]` or `./<path>.js [args]` invocations pointing inside `.pi/skills/` are accepted; all other commands return an error.',
  parameters: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'Command to run (e.g. `node .pi/skills/foo/foo.js arg1 arg2`).',
      },
      cwd: {
        type: 'string',
        description: 'Working directory (optional). Defaults to the script directory.',
      },
    },
    required: ['command'],
    additionalProperties: false,
  },
};

export interface BashSkillServiceOptions {
  /** Constructed/shared instance to drive sandbox runs. */
  sandbox: SandboxHost;
  /** Absolute vault mount. Defaults to `/vault`. */
  vaultMount?: string;
  /** Per-run timeout (ms). Defaults to the sandbox host default. */
  timeoutMs?: number;
  /** Receives every stdout/stderr line during a run (e.g. for UI tooltips). */
  onConsole?: (stream: 'log' | 'error', text: string) => void;
}

interface ParsedCommand {
  scriptPath: string;
  args: string[];
}

/** Whitespace-aware command tokenizer that respects quotes. */
function tokenize(command: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: string | null = null;
  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ' ' || ch === '\t') {
      if (current) {
        tokens.push(current);
        current = '';
      }
    } else {
      current += ch;
    }
  }
  if (current) tokens.push(current);
  return tokens;
}

function resolveScriptPath(raw: string, vaultMount: string): string | null {
  if (!raw.endsWith('.js')) return null;
  const mount = vaultMount.endsWith('/') ? vaultMount.slice(0, -1) : vaultMount;
  if (raw.startsWith('/')) return raw;
  const stripped = raw.startsWith('./') ? raw.slice(2) : raw;
  return `${mount}/${stripped}`;
}

/**
 * Parse `command` strictly into a `(scriptPath, args)` pair, or return
 * a rejection message when the command doesn't match the allowed
 * shapes. Allowed shapes:
 *
 *   node <path>.js [args...]
 *   ./<path>.js [args...]
 *   <path>.js [args...]          (relative, resolved under vault)
 *
 * The resolved script path must live beneath `<vaultMount>/.pi/skills/`.
 */
export function parseBashSkillCommand(
  command: string,
  vaultMount = '/vault'
): ParsedCommand | { error: string } {
  const tokens = tokenize(command.trim());
  if (tokens.length === 0) {
    return { error: 'empty command' };
  }

  let rawScript: string;
  let rest: string[];
  if (tokens[0] === 'node') {
    if (tokens.length < 2) return { error: 'node expects a script path' };
    rawScript = tokens[1];
    rest = tokens.slice(2);
  } else if (tokens[0].endsWith('.js')) {
    rawScript = tokens[0];
    rest = tokens.slice(1);
  } else {
    return {
      error: `bash-skill only accepts JS script invocations (node <path>.js or ./<path>.js); got: ${command}`,
    };
  }

  const scriptPath = resolveScriptPath(rawScript, vaultMount);
  if (!scriptPath) {
    return { error: `script must end in .js; got: ${rawScript}` };
  }

  const skillsRoot = `${
    vaultMount.endsWith('/') ? vaultMount.slice(0, -1) : vaultMount
  }/${SKILLS_DIR_SEGMENT}/`;
  if (!scriptPath.startsWith(skillsRoot)) {
    return {
      error: `bash-skill only runs scripts under ${skillsRoot}; got: ${scriptPath}`,
    };
  }

  return { scriptPath, args: rest };
}

function dirname(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx <= 0 ? '/' : path.slice(0, idx);
}

function formatToolResult(result: SandboxRunResult): BashSkillToolResult {
  const parts: string[] = [];
  parts.push('=== STDOUT ===');
  parts.push(result.stdout || '');
  parts.push('=== STDERR ===');
  parts.push(result.stderr || '');
  parts.push(`=== EXIT ${result.exitCode} ===`);
  if (result.errorMessage) parts.push(`error: ${result.errorMessage}`);
  return {
    content: [{ type: 'text', text: parts.join('\n') }],
    isError: result.exitCode !== 0,
  };
}

/**
 * Service that implements the `bash` MCP tool on the main thread.
 * Construct once per session; the RPC layer forwards each
 * `tool_call_request` for `bash` into `invoke()`.
 */
export class BashSkillService {
  private readonly sandbox: SandboxHost;
  private readonly vaultMount: string;
  private readonly timeoutMs?: number;
  private readonly onConsole?: (stream: 'log' | 'error', text: string) => void;

  constructor(options: BashSkillServiceOptions) {
    this.sandbox = options.sandbox;
    this.vaultMount = options.vaultMount ?? '/vault';
    this.timeoutMs = options.timeoutMs;
    this.onConsole = options.onConsole;
  }

  async invoke(args: unknown): Promise<BashSkillToolResult> {
    const parsedArgs = args as { command?: unknown; cwd?: unknown } | null;
    const command = typeof parsedArgs?.command === 'string' ? parsedArgs.command : '';
    const explicitCwd = typeof parsedArgs?.cwd === 'string' ? parsedArgs.cwd : undefined;

    if (!command) {
      return {
        content: [{ type: 'text', text: 'bash-skill: `command` is required' }],
        isError: true,
      };
    }

    const parsed = parseBashSkillCommand(command, this.vaultMount);
    if ('error' in parsed) {
      return {
        content: [{ type: 'text', text: `bash-skill: ${parsed.error}` }],
        isError: true,
      };
    }

    let source: string;
    try {
      const buf = await fs.promises.readFile(parsed.scriptPath);
      source = new TextDecoder().decode(buf as unknown as ArrayBuffer);
    } catch (err) {
      return {
        content: [
          {
            type: 'text',
            text: `bash-skill: cannot read ${parsed.scriptPath}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          },
        ],
        isError: true,
      };
    }

    const cwd = explicitCwd ?? dirname(parsed.scriptPath);
    const capabilityHandler = buildDefaultCapabilityHandler({
      vaultMount: this.vaultMount,
      onConsole: this.onConsole,
    });
    const runResult = await this.sandbox.run(
      {
        source,
        scriptPath: parsed.scriptPath,
        args: parsed.args,
        stdin: '',
        cwd,
        ...(this.timeoutMs ? { timeoutMs: this.timeoutMs } : {}),
      },
      capabilityHandler
    );
    return formatToolResult(runResult);
  }
}
