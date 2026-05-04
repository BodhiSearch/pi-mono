import { describe, expect, it, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { bootstrapCli } from '../src';

describe('cli /quit', () => {
  it('prints "application exited" and signals exit', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let captured = '';
    output.on('data', (chunk: Buffer) => {
      captured += chunk.toString('utf8');
    });
    const exit = vi.fn();

    const done = bootstrapCli({ input, output, exit });
    input.write('/quit\n');
    await done;

    expect(captured).toContain('application exited');
    expect(exit).toHaveBeenCalledTimes(1);
  });
});
