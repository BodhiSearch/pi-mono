/**
 * `bash` AgentTool built on `just-bash`'s browser build.
 *
 * - Mounts each registered volume (`/mnt/<name>`) via `MountableFs` +
 *   `VolumeFileSystem` so the shell sees exactly what the ZenFS VFS
 *   exposes to the worker.
 * - Adds ephemeral `InMemoryFs` mounts for `/tmp` and `/home/user` so
 *   scripts have a scratch space without touching user volumes.
 * - Surfaces execution results as a single JSON text block the model
 *   can parse plus a richer `details` payload the UI renders.
 * - Cooperative cancellation via `AbortController`; timeout support via
 *   `params.timeout_ms`. Outputs over 256 KB are truncated per-stream.
 */
import type {
  AgentTool,
  AgentToolResult,
  AgentToolUpdateCallback,
} from '@mariozechner/pi-agent-core';
import { Type, type Static } from '@sinclair/typebox';
import {
  Bash,
  InMemoryFs,
  MountableFs,
  type BashExecResult,
  type IFileSystem,
} from 'just-bash/browser';
import type { VolumeRegistry } from '../volume-mount';
import { VolumeFileSystem } from './volume-filesystem';

export const BASH_OUTPUT_BYTE_LIMIT = 256 * 1024;

export const bashInputSchema = Type.Object({
  script: Type.String({
    description: 'Bash script to execute. Supports pipes, redirections, and control flow.',
  }),
  cwd: Type.Optional(
    Type.String({
      description: 'Absolute working directory for the script (defaults to /mnt/<firstVolume>).',
    })
  ),
  timeout_ms: Type.Optional(
    Type.Number({
      description: 'Hard timeout in milliseconds. Defaults to no timeout.',
      minimum: 1,
    })
  ),
  stdin: Type.Optional(
    Type.String({
      description: 'Standard input piped into the script.',
    })
  ),
});

export type BashToolInput = Static<typeof bashInputSchema>;

export interface BashToolDetails {
  stdout: string;
  stderr: string;
  exitCode: number;
  truncated: boolean;
}

export interface BashToolDeps {
  registry: VolumeRegistry;
}

const BASH_DESCRIPTION = [
  'Execute a bash script inside a sandboxed browser shell. Volumes mounted at',
  '/mnt/<name> are visible and writable. /tmp and /home/user are ephemeral',
  'scratch spaces that reset per turn. Returns JSON with stdout, stderr,',
  'exitCode, and a truncated flag when output exceeds 256 KiB per stream.',
].join(' ');

export function createBashTool(
  deps: BashToolDeps
): AgentTool<typeof bashInputSchema, BashToolDetails> {
  return {
    name: 'bash',
    label: 'Bash',
    description: BASH_DESCRIPTION,
    parameters: bashInputSchema,
    async execute(
      _toolCallId: string,
      params: BashToolInput,
      signal?: AbortSignal,
      onUpdate?: AgentToolUpdateCallback<BashToolDetails>
    ): Promise<AgentToolResult<BashToolDetails>> {
      const cwd = resolveCwd(params.cwd, deps.registry);
      const fs = buildMountable(deps.registry);
      const bash = new Bash({ fs, cwd });

      const controllers: AbortController[] = [];
      const combined = linkSignals(signal, params.timeout_ms, controllers);
      if (onUpdate) {
        onUpdate({
          content: [{ type: 'text', text: '' }],
          details: { stdout: '', stderr: '', exitCode: -1, truncated: false },
        });
      }

      let result: BashExecResult;
      try {
        result = await bash.exec(params.script, {
          signal: combined.signal,
          ...(params.stdin === undefined ? {} : { stdin: params.stdin }),
          cwd,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const details: BashToolDetails = {
          stdout: '',
          stderr: message,
          exitCode: combined.signal.aborted ? 130 : 1,
          truncated: false,
        };
        return toolResult(details);
      } finally {
        for (const controller of controllers) controller.abort();
      }

      const { stdout, stderr, truncated } = truncateStreams(result.stdout, result.stderr);
      const details: BashToolDetails = {
        stdout,
        stderr,
        exitCode: result.exitCode,
        truncated,
      };
      return toolResult(details);
    },
  };
}

function toolResult(details: BashToolDetails): AgentToolResult<BashToolDetails> {
  return {
    content: [{ type: 'text', text: JSON.stringify(details) }],
    details,
  };
}

function resolveCwd(cwdParam: string | undefined, registry: VolumeRegistry): string {
  if (cwdParam) return cwdParam;
  const first = registry.firstMountName();
  return first ? `/mnt/${first}` : '/home/user';
}

function buildMountable(registry: VolumeRegistry): IFileSystem {
  const volumeMounts = registry.list().map(entry => ({
    mountPoint: `/mnt/${entry.mountName}`,
    filesystem: new VolumeFileSystem(`/mnt/${entry.mountName}`) as IFileSystem,
  }));
  const scratchMounts = [
    { mountPoint: '/tmp', filesystem: new InMemoryFs() as IFileSystem },
    { mountPoint: '/home/user', filesystem: new InMemoryFs() as IFileSystem },
  ];
  return new MountableFs({
    base: new InMemoryFs(),
    mounts: [...volumeMounts, ...scratchMounts],
  });
}

interface LinkedSignal {
  signal: AbortSignal;
}

function linkSignals(
  external: AbortSignal | undefined,
  timeoutMs: number | undefined,
  controllers: AbortController[]
): LinkedSignal {
  const controller = new AbortController();
  controllers.push(controller);
  if (external) {
    if (external.aborted) controller.abort(external.reason);
    else
      external.addEventListener('abort', () => controller.abort(external.reason), { once: true });
  }
  if (typeof timeoutMs === 'number' && timeoutMs > 0) {
    const timer = setTimeout(() => controller.abort(new Error('bash timeout exceeded')), timeoutMs);
    controller.signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
  }
  return { signal: controller.signal };
}

function truncateStreams(
  rawStdout: string,
  rawStderr: string
): { stdout: string; stderr: string; truncated: boolean } {
  const outBytes = byteLength(rawStdout);
  const errBytes = byteLength(rawStderr);
  const stdoutTruncated = outBytes > BASH_OUTPUT_BYTE_LIMIT;
  const stderrTruncated = errBytes > BASH_OUTPUT_BYTE_LIMIT;
  return {
    stdout: stdoutTruncated ? truncateToBytes(rawStdout, BASH_OUTPUT_BYTE_LIMIT) : rawStdout,
    stderr: stderrTruncated ? truncateToBytes(rawStderr, BASH_OUTPUT_BYTE_LIMIT) : rawStderr,
    truncated: stdoutTruncated || stderrTruncated,
  };
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function truncateToBytes(value: string, limit: number): string {
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength <= limit) return value;
  const slice = bytes.subarray(0, limit);
  return new TextDecoder('utf-8', { fatal: false }).decode(slice);
}
