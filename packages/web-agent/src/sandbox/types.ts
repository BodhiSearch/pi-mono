/**
 * Wire-level types for the skill-execution sandbox.
 *
 * The sandbox is a three-layer structure:
 *
 *   agent worker ←→ main thread (SandboxHost) ←→ iframe (null-origin) ←→ Worker (skill code)
 *
 * All messages cross structured-clone boundaries — no function refs,
 * no prototype smuggling. Capability requests originate inside the
 * skill Worker, bubble up through the iframe to the host, and the
 * host services them against the mounted vault (or the live `fetch`
 * with CORS gating).
 */

export interface SandboxRunInput {
  /** Monotonic id — assigned by `SandboxHost.run`. */
  jobId: string;
  /** Raw JavaScript source of the skill script. */
  source: string;
  /** Absolute vault path the script was resolved from (for error messages). */
  scriptPath: string;
  /** Command-line args (after the script path), mirrors `process.argv.slice(2)`. */
  args: string[];
  /** Optional stdin text piped into the script. Empty string when unused. */
  stdin: string;
  /** Working directory shown to the script, typically `dirname(scriptPath)`. */
  cwd: string;
  /** Max wall-clock time before the Worker is terminated. Defaults to 10s in the host. */
  timeoutMs: number;
}

export interface SandboxRunResult {
  jobId: string;
  stdout: string;
  stderr: string;
  /** 0 on clean exit, non-zero on thrown error or timeout. */
  exitCode: number;
  /** Short description when the job terminated abnormally (timeout, thrown error). */
  errorMessage?: string;
}

/**
 * Capability request the skill Worker posts into the iframe. The
 * iframe forwards it to the host verbatim; the host services it and
 * replies with a matching `SandboxCapabilityResponse`.
 *
 * The discriminator is the `type` field. A `requestId` generated
 * inside the skill Worker pairs request with response.
 */
export type SandboxCapabilityRequest =
  | {
      type: 'vault.readFile';
      requestId: string;
      path: string;
    }
  | {
      type: 'vault.writeFile';
      requestId: string;
      path: string;
      content: string;
    }
  | {
      type: 'vault.ls';
      requestId: string;
      path: string;
    }
  | {
      type: 'fetch';
      requestId: string;
      url: string;
      init?: {
        method?: string;
        headers?: Record<string, string>;
        body?: string;
      };
    }
  | {
      type: 'console';
      requestId: string;
      stream: 'log' | 'error';
      text: string;
    };

export type SandboxCapabilityResponse =
  | {
      type: 'vault.readFile.result';
      requestId: string;
      ok: true;
      content: string;
    }
  | {
      type: 'vault.writeFile.result';
      requestId: string;
      ok: true;
    }
  | {
      type: 'vault.ls.result';
      requestId: string;
      ok: true;
      entries: string[];
    }
  | {
      type: 'fetch.result';
      requestId: string;
      ok: true;
      status: number;
      statusText: string;
      headers: Record<string, string>;
      body: string;
    }
  | {
      type: 'console.result';
      requestId: string;
      ok: true;
    }
  | {
      type: 'capability.error';
      requestId: string;
      ok: false;
      errorMessage: string;
    };

/** Messages from host → iframe (drive a run). */
export type HostToIframeMessage =
  | { type: 'run'; input: SandboxRunInput }
  | { type: 'capability.response'; response: SandboxCapabilityResponse };

/** Messages from iframe → host (capability upcalls, run completion). */
export type IframeToHostMessage =
  | { type: 'ready' }
  | { type: 'capability.request'; request: SandboxCapabilityRequest }
  | { type: 'result'; result: SandboxRunResult };
