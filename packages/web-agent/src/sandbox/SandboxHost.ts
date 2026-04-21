/**
 * Main-thread sandbox host — the bridge between the agent Worker's
 * bash-shim tool and a null-origin iframe that runs skill JavaScript.
 *
 * Lifecycle:
 * - Construct once per provider. Lazily creates a hidden
 *   `sandbox="allow-scripts"` iframe on the first `run()` call and
 *   keeps it alive until `dispose()`.
 * - Each `run()` posts a `run` message and resolves with the
 *   structured-clone result. Capability requests from the skill are
 *   routed to a pluggable `SandboxCapabilityHandler`, which is where
 *   vault access, fetch, and console piping are enforced.
 *
 * Security:
 * - Iframe is created with `sandbox="allow-scripts"` only — no
 *   `allow-same-origin`. That puts it in a null origin: `document.cookie`,
 *   `localStorage`, `indexedDB`, and `caches.open` all throw.
 * - Iframe is also hidden and positioned off-screen so a skill cannot
 *   render UI or flash pixels at the user.
 * - We never pass function references across `postMessage`; only
 *   structured-clone-safe values.
 */

import { buildIframeSrcdoc } from './bootstrap';
import type {
  HostToIframeMessage,
  IframeToHostMessage,
  SandboxCapabilityRequest,
  SandboxCapabilityResponse,
  SandboxRunInput,
  SandboxRunResult,
} from './types';

export interface SandboxCapabilityHandler {
  (request: SandboxCapabilityRequest): Promise<SandboxCapabilityResponse>;
}

export interface SandboxHostOptions {
  /** Defaults to 10_000ms. Overridable per-run via `SandboxRunInput.timeoutMs`. */
  defaultTimeoutMs?: number;
  /** Injected by tests to avoid DOM setup; production uses `document`. */
  documentRef?: Document;
  /** Injected by tests to mock postMessage delivery. Production uses `window`. */
  windowRef?: Window;
}

type PendingJob = {
  resolve: (result: SandboxRunResult) => void;
  reject: (err: Error) => void;
};

export class SandboxHost {
  private iframe: HTMLIFrameElement | null = null;
  private iframeReadyPromise: Promise<void> | null = null;
  private iframeReadyResolve: (() => void) | null = null;
  private readonly jobs = new Map<string, PendingJob>();
  private readonly capabilityHandlers = new Map<string, SandboxCapabilityHandler>();
  private readonly defaultTimeoutMs: number;
  private readonly doc: Document;
  private readonly win: Window;
  private messageListener: ((ev: MessageEvent) => void) | null = null;
  private nextJobId = 0;

  constructor(options: SandboxHostOptions = {}) {
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 10_000;
    this.doc = options.documentRef ?? document;
    this.win = options.windowRef ?? window;
  }

  /**
   * Execute a skill inside the sandbox. Each call is independent —
   * the iframe spawns a fresh Worker per job so one skill cannot
   * observe another's side effects.
   */
  async run(
    input: Omit<SandboxRunInput, 'jobId' | 'timeoutMs'> & { timeoutMs?: number },
    capabilityHandler: SandboxCapabilityHandler
  ): Promise<SandboxRunResult> {
    await this.ensureIframe();
    const jobId = `job-${++this.nextJobId}`;
    const fullInput: SandboxRunInput = {
      ...input,
      jobId,
      timeoutMs: input.timeoutMs ?? this.defaultTimeoutMs,
    };
    this.capabilityHandlers.set(jobId, capabilityHandler);

    const resultPromise = new Promise<SandboxRunResult>((resolve, reject) => {
      this.jobs.set(jobId, { resolve, reject });
    });

    this.postToIframe({ type: 'run', input: fullInput });

    try {
      return await resultPromise;
    } finally {
      this.capabilityHandlers.delete(jobId);
      this.jobs.delete(jobId);
    }
  }

  /** Tear down the iframe and reject any outstanding jobs. */
  dispose(): void {
    if (this.messageListener) {
      this.win.removeEventListener('message', this.messageListener);
      this.messageListener = null;
    }
    if (this.iframe && this.iframe.parentNode) {
      this.iframe.parentNode.removeChild(this.iframe);
    }
    this.iframe = null;
    this.iframeReadyPromise = null;
    this.iframeReadyResolve = null;
    for (const [, job] of this.jobs) {
      job.reject(new Error('sandbox disposed'));
    }
    this.jobs.clear();
    this.capabilityHandlers.clear();
  }

  private ensureIframe(): Promise<void> {
    if (this.iframeReadyPromise) return this.iframeReadyPromise;

    this.iframeReadyPromise = new Promise<void>(resolve => {
      this.iframeReadyResolve = resolve;
    });

    const iframe = this.doc.createElement('iframe');
    iframe.setAttribute('sandbox', 'allow-scripts');
    iframe.setAttribute('aria-hidden', 'true');
    iframe.setAttribute('title', 'pi-skill-sandbox');
    iframe.style.position = 'absolute';
    iframe.style.width = '0';
    iframe.style.height = '0';
    iframe.style.border = '0';
    iframe.style.left = '-9999px';
    iframe.style.top = '-9999px';
    iframe.srcdoc = buildIframeSrcdoc();
    this.iframe = iframe;

    this.messageListener = (ev: MessageEvent) => this.handleMessage(ev);
    this.win.addEventListener('message', this.messageListener);

    this.doc.body.appendChild(iframe);

    return this.iframeReadyPromise;
  }

  private handleMessage(ev: MessageEvent): void {
    if (!this.iframe || ev.source !== this.iframe.contentWindow) return;
    const data = ev.data as IframeToHostMessage;
    if (!data || typeof data !== 'object') return;

    if (data.type === 'ready') {
      this.iframeReadyResolve?.();
      return;
    }

    if (data.type === 'result') {
      const job = this.jobs.get(data.result.jobId);
      if (!job) return;
      job.resolve(data.result);
      return;
    }

    if (data.type === 'capability.request') {
      this.handleCapabilityRequest(data.request);
      return;
    }
  }

  private async handleCapabilityRequest(
    request: SandboxCapabilityRequest & { jobId?: string }
  ): Promise<void> {
    const jobId = (request as SandboxCapabilityRequest & { jobId?: string }).jobId;
    const handler = jobId ? this.capabilityHandlers.get(jobId) : undefined;
    let response: SandboxCapabilityResponse;
    if (!handler) {
      response = {
        type: 'capability.error',
        requestId: request.requestId,
        ok: false,
        errorMessage: 'no capability handler for job',
      };
    } else {
      try {
        response = await handler(request);
      } catch (err) {
        response = {
          type: 'capability.error',
          requestId: request.requestId,
          ok: false,
          errorMessage: err instanceof Error ? err.message : String(err),
        };
      }
    }
    this.postToIframe({
      type: 'capability.response',
      response: { ...response, jobId } as SandboxCapabilityResponse & { jobId?: string },
    });
  }

  private postToIframe(message: HostToIframeMessage): void {
    const target = this.iframe?.contentWindow;
    if (!target) return;
    target.postMessage(message, '*');
  }
}
