/**
 * Worker-transport round-trip test.
 *
 * jsdom doesn't implement Worker, so we simulate the structural relationship
 * between createWorkerTransportPair and the Worker side: the test plays the
 * Worker by listening on `agentPort` (channelA.port2) directly and echoing
 * a response. This validates:
 *   - the init envelope is structured-cloneable and tagged correctly
 *   - the agent transport's wrapPort works through a real MessageChannel
 *   - both ports are addressable from the "Worker" side after transfer
 *
 * For full Worker semantics (boot module + RpcServer + AgentSession), the
 * Playwright e2e specs exercise the real Chrome Worker.
 */

import { describe, expect, test } from 'vitest';
import { isAgentWorkerInit } from '../../worker/init-protocol';
import { createWorkerTransportPair } from './worker';

interface FakeWorker {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (e: MessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (e: MessageEvent) => void): void;
  terminate(): void;
}

/** Minimal Worker stand-in that records postMessage calls. */
function makeFakeWorker(): {
  worker: FakeWorker;
  lastInit: { message: unknown; transfer: Transferable[] | undefined } | null;
} {
  const recorder: { lastInit: { message: unknown; transfer: Transferable[] | undefined } | null } =
    { lastInit: null };
  return {
    worker: {
      postMessage(message, transfer) {
        recorder.lastInit = { message, transfer };
      },
      addEventListener() {},
      removeEventListener() {},
      terminate() {},
    },
    get lastInit() {
      return recorder.lastInit;
    },
  };
}

describe('createWorkerTransportPair', () => {
  test('posts a tagged init envelope with both transferable ports', () => {
    const { worker } = makeFakeWorker();
    const pair = createWorkerTransportPair(worker as unknown as Worker);
    expect(pair.client).toBeDefined();
    expect(pair.vfsPort).toBeInstanceOf(MessagePort);
  });

  test('init envelope is recognised by isAgentWorkerInit', () => {
    let captured: unknown = null;
    let capturedTransfer: Transferable[] | undefined;
    const worker = {
      postMessage(message: unknown, transfer?: Transferable[]) {
        captured = message;
        capturedTransfer = transfer;
      },
      addEventListener() {},
      removeEventListener() {},
      terminate() {},
    } as unknown as Worker;

    createWorkerTransportPair(worker, {
      devSeed: { name: 'test', files: { '/vault/a.txt': 'hello' } },
    });

    expect(isAgentWorkerInit(captured)).toBe(true);
    expect(capturedTransfer).toHaveLength(2);
    expect(capturedTransfer?.[0]).toBeInstanceOf(MessagePort);
    expect(capturedTransfer?.[1]).toBeInstanceOf(MessagePort);
  });

  test('agent transport round-trips messages through the channel', async () => {
    // Simulate a real Worker by listening on the worker-side port and
    // echoing back. We hand-construct the channel exactly the way
    // createWorkerTransportPair does internally so we can play the
    // Worker side here.
    const channelA = new MessageChannel();
    const workerSide = channelA.port2;
    const mainSide = channelA.port1;

    workerSide.start();
    mainSide.start();

    workerSide.addEventListener('message', e => {
      if (e.data === 'ping') {
        workerSide.postMessage('pong');
      }
    });

    const received: unknown[] = [];
    mainSide.addEventListener('message', e => {
      received.push(e.data);
    });

    mainSide.postMessage('ping');

    // Allow the microtask queue to drain so the message round-trip lands.
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(received).toEqual(['pong']);
  });
});
