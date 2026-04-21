/**
 * Inline bootstrap sources for the sandbox iframe and its skill
 * Worker.
 *
 * Both strings are loaded verbatim at runtime — the iframe HTML is
 * injected via `srcdoc`, and the skill Worker is spawned from a
 * `Blob` URL assembled inside the iframe. Keeping the sources as
 * template literals (rather than Vite `?raw` imports) avoids a build
 * plugin dependency and keeps the bundle understandable.
 *
 * Message protocol: see `types.ts` — all traffic uses structured
 * clone. The Worker prefixes its capability requests with a
 * `requestId` string it allocates; the iframe forwards both
 * directions verbatim and holds no per-request state.
 */

/**
 * Source of the skill Worker's bootstrap. Runs inside the Worker
 * global scope. Receives a `postMessage({ type: 'run', input, apiShim })`
 * kick from the iframe and evaluates the skill source with
 * `new Function(...)` so it cannot touch host globals.
 *
 * Capability requests (`vault.readFile`, `fetch`, `console.log`, …)
 * round-trip via `postMessage` back to the iframe, which forwards
 * them to the host. The Worker blocks on a Promise that resolves
 * when the matching `capability.response` arrives.
 */
export const SKILL_WORKER_SOURCE = `
(() => {
  const pending = new Map();
  let nextId = 0;
  function uid() { return 'cap-' + (++nextId); }
  function request(req) {
    return new Promise((resolve, reject) => {
      const requestId = uid();
      pending.set(requestId, { resolve, reject });
      self.postMessage({ type: 'capability.request', request: Object.assign({}, req, { requestId }) });
    });
  }
  self.addEventListener('message', (ev) => {
    const data = ev.data;
    if (!data || typeof data !== 'object') return;
    if (data.type === 'capability.response') {
      const p = pending.get(data.response.requestId);
      if (!p) return;
      pending.delete(data.response.requestId);
      if (data.response.ok) p.resolve(data.response);
      else p.reject(new Error(data.response.errorMessage || 'capability error'));
      return;
    }
    if (data.type === 'run') {
      runSkill(data.input);
    }
  });
  async function runSkill(input) {
    const stdoutChunks = [];
    const stderrChunks = [];
    const writeStdout = (text) => { stdoutChunks.push(text); request({ type: 'console', stream: 'log', text }).catch(() => {}); };
    const writeStderr = (text) => { stderrChunks.push(text); request({ type: 'console', stream: 'error', text }).catch(() => {}); };
    const stringify = (args) => args.map(a => {
      if (typeof a === 'string') return a;
      try { return JSON.stringify(a); } catch { return String(a); }
    }).join(' ');
    const consoleShim = {
      log: (...args) => writeStdout(stringify(args)),
      info: (...args) => writeStdout(stringify(args)),
      warn: (...args) => writeStderr(stringify(args)),
      error: (...args) => writeStderr(stringify(args)),
      debug: (...args) => writeStdout(stringify(args)),
    };
    const vault = {
      readFile: async (path) => (await request({ type: 'vault.readFile', path })).content,
      writeFile: async (path, content) => { await request({ type: 'vault.writeFile', path, content: String(content) }); },
      ls: async (path) => (await request({ type: 'vault.ls', path })).entries,
    };
    const fetchShim = async (url, init) => {
      const response = await request({
        type: 'fetch',
        url: String(url),
        init: init ? {
          method: init.method,
          headers: init.headers && typeof init.headers === 'object' ? Object.fromEntries(Object.entries(init.headers)) : undefined,
          body: typeof init.body === 'string' ? init.body : undefined,
        } : undefined,
      });
      return {
        status: response.status,
        statusText: response.statusText,
        ok: response.status >= 200 && response.status < 300,
        headers: { get: (k) => response.headers[String(k).toLowerCase()] ?? null },
        text: async () => response.body,
        json: async () => JSON.parse(response.body),
      };
    };
    const argv = ['node', input.scriptPath].concat(input.args || []);
    const env = {};
    const processShim = { argv, env, cwd: () => input.cwd, exit: (code) => { throw new __SkillExit(typeof code === 'number' ? code : 0); } };
    function __SkillExit(code) { this.code = code; this.__skillExit = true; }
    try {
      // Wrap the skill source in an async IIFE so scripts can use
      // top-level await naturally (and we can always await the
      // resulting promise). Using new Function keeps the evaluation
      // off the host globals — the script only sees the shims we
      // thread in as parameters.
      const fn = new Function('console', 'fetch', 'vault', 'process', 'args', 'stdin', 'cwd', '__SkillExit',
        '"use strict";\\nreturn (async () => {\\n' + input.source + '\\n})();');
      await fn(consoleShim, fetchShim, vault, processShim, input.args || [], input.stdin || '', input.cwd, __SkillExit);
      self.postMessage({ type: 'result', result: { jobId: input.jobId, stdout: stdoutChunks.join('\\n'), stderr: stderrChunks.join('\\n'), exitCode: 0 } });
    } catch (err) {
      if (err && err.__skillExit) {
        self.postMessage({ type: 'result', result: { jobId: input.jobId, stdout: stdoutChunks.join('\\n'), stderr: stderrChunks.join('\\n'), exitCode: err.code | 0 } });
        return;
      }
      const message = err && err.message ? String(err.message) : String(err);
      stderrChunks.push(message);
      self.postMessage({ type: 'result', result: { jobId: input.jobId, stdout: stdoutChunks.join('\\n'), stderr: stderrChunks.join('\\n'), exitCode: 1, errorMessage: message } });
    }
  }
  self.postMessage({ type: 'worker-ready' });
})();
`;

/**
 * Source of the iframe bootstrap. Runs at document-ready time.
 * Responsibilities:
 * 1. Notify the parent that the iframe is up (`ready`).
 * 2. On every `run`, spawn a fresh `Worker` from the embedded
 *    `SKILL_WORKER_SOURCE` Blob, wire two-way message forwarding,
 *    arm a timeout, and relay the `result`.
 * 3. Forward capability requests from the Worker to the parent and
 *    capability responses from the parent back to the Worker.
 *
 * Each run gets a brand-new Worker so one skill cannot leave state
 * behind for the next. The iframe itself is long-lived so we pay
 * the iframe setup cost once per tab lifetime.
 */
// Defensive split so the literal `</script>` never appears in this
// source file — keeps linters happy and prevents an early-close if
// a bundler ever inlines this module into an HTML <script> tag.
const CLOSING_SCRIPT_TAG = '</scr' + 'ipt>';

export function buildIframeSrcdoc(): string {
  const workerSourceLiteral = JSON.stringify(SKILL_WORKER_SOURCE);
  return `<!doctype html>
<html>
<head><meta charset="utf-8"></head>
<body>
<script>
(() => {
  const workerSource = ${workerSourceLiteral};
  const runs = new Map();
  function spawnWorker() {
    const blob = new Blob([workerSource], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    const worker = new Worker(url);
    URL.revokeObjectURL(url);
    return worker;
  }
  window.addEventListener('message', (ev) => {
    const data = ev.data;
    if (!data || typeof data !== 'object') return;
    if (data.type === 'run') {
      const input = data.input;
      const jobId = input.jobId;
      const worker = spawnWorker();
      const timeout = setTimeout(() => {
        try { worker.terminate(); } catch {}
        const run = runs.get(jobId);
        if (!run) return;
        runs.delete(jobId);
        window.parent.postMessage({ type: 'result', result: { jobId, stdout: '', stderr: 'skill timed out after ' + input.timeoutMs + 'ms', exitCode: 124, errorMessage: 'timeout' } }, '*');
      }, Math.max(1, input.timeoutMs | 0));
      runs.set(jobId, { worker, timeout });
      worker.addEventListener('message', (wev) => {
        const wd = wev.data;
        if (!wd || typeof wd !== 'object') return;
        if (wd.type === 'capability.request') {
          window.parent.postMessage({ type: 'capability.request', request: Object.assign({}, wd.request, { jobId }) }, '*');
          return;
        }
        if (wd.type === 'result') {
          const run = runs.get(jobId);
          if (run) { clearTimeout(run.timeout); try { run.worker.terminate(); } catch {} runs.delete(jobId); }
          window.parent.postMessage({ type: 'result', result: wd.result }, '*');
          return;
        }
      });
      worker.addEventListener('error', (err) => {
        const run = runs.get(jobId);
        if (!run) return;
        clearTimeout(run.timeout);
        try { run.worker.terminate(); } catch {}
        runs.delete(jobId);
        const message = (err && err.message) || 'worker error';
        window.parent.postMessage({ type: 'result', result: { jobId, stdout: '', stderr: String(message), exitCode: 1, errorMessage: String(message) } }, '*');
      });
      worker.postMessage({ type: 'run', input });
      return;
    }
    if (data.type === 'capability.response') {
      const jobId = data.response.jobId;
      const run = runs.get(jobId);
      if (!run) return;
      const forwarded = Object.assign({}, data.response);
      delete forwarded.jobId;
      run.worker.postMessage({ type: 'capability.response', response: forwarded });
      return;
    }
  });
  window.parent.postMessage({ type: 'ready' }, '*');
})();
${CLOSING_SCRIPT_TAG}
</body>
</html>`;
}
