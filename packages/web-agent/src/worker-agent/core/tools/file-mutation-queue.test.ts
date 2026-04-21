import { beforeEach, describe, expect, test } from 'vitest';
import { __resetFileMutationQueuesForTests, withFileMutationQueue } from './file-mutation-queue';

beforeEach(() => {
  __resetFileMutationQueuesForTests();
});

describe('withFileMutationQueue', () => {
  test('serialises concurrent calls on the same path', async () => {
    const trace: string[] = [];

    async function task(label: string, delay: number) {
      trace.push(`start:${label}`);
      await new Promise(r => setTimeout(r, delay));
      trace.push(`end:${label}`);
      return label;
    }

    const [a, b, c] = await Promise.all([
      withFileMutationQueue('/vault/a.txt', () => task('A', 20)),
      withFileMutationQueue('/vault/a.txt', () => task('B', 5)),
      withFileMutationQueue('/vault/a.txt', () => task('C', 1)),
    ]);

    expect([a, b, c]).toEqual(['A', 'B', 'C']);
    // A fully completes before B starts, B fully completes before C starts.
    expect(trace).toEqual(['start:A', 'end:A', 'start:B', 'end:B', 'start:C', 'end:C']);
  });

  test('allows concurrent calls on different paths', async () => {
    const events: string[] = [];

    async function task(label: string, delay: number) {
      events.push(`start:${label}`);
      await new Promise(r => setTimeout(r, delay));
      events.push(`end:${label}`);
      return label;
    }

    await Promise.all([
      withFileMutationQueue('/vault/a.txt', () => task('A', 25)),
      withFileMutationQueue('/vault/b.txt', () => task('B', 5)),
    ]);

    // B finishes entirely while A is still running.
    expect(events).toEqual(['start:A', 'start:B', 'end:B', 'end:A']);
  });

  test('normalises paths so /vault/a.txt and /vault/./a.txt share a queue', async () => {
    const trace: string[] = [];

    async function task(label: string, delay: number) {
      trace.push(`start:${label}`);
      await new Promise(r => setTimeout(r, delay));
      trace.push(`end:${label}`);
    }

    await Promise.all([
      withFileMutationQueue('/vault/a.txt', () => task('A', 20)),
      withFileMutationQueue('/vault/./a.txt', () => task('B', 5)),
    ]);

    expect(trace).toEqual(['start:A', 'end:A', 'start:B', 'end:B']);
  });

  test('propagates thrown errors without breaking subsequent queue entries', async () => {
    await expect(
      withFileMutationQueue('/vault/a.txt', async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');

    // Queue should still accept new operations on the same path.
    const result = await withFileMutationQueue('/vault/a.txt', async () => 'ok');
    expect(result).toBe('ok');
  });
});
