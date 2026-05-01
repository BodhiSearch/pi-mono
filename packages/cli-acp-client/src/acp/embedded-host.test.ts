import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEmbeddedHost, type EmbeddedHost } from './embedded-host';

let tmpDir: string;
let host: EmbeddedHost | undefined;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cli-acp-emb-'));
});

afterEach(async () => {
  if (host) {
    await host.dispose();
    host = undefined;
  }
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('createEmbeddedHost', () => {
  it('boots an in-process agent the client can initialize against', async () => {
    host = await createEmbeddedHost({ cwd: tmpDir });
    expect(host.client).toBeDefined();
    // `initialize` is already called inside `createEmbeddedHost`. Re-issuing
    // listVolumes proves the connection round-trips and shows the auto
    // cwd volume.
    const volumes = await host.client.listVolumes();
    const names = volumes.map(v => v.mountName);
    expect(names).toContain('cwd');
  });

  it('rejects listModels until authenticate has been called', async () => {
    host = await createEmbeddedHost({ cwd: tmpDir });
    // The JSON-RPC layer wraps the underlying `setAuthToken`-not-called
    // error as a generic `Internal error`. We assert "rejects" rather
    // than match on the message because the SDK reserves the message
    // shape and we don't want to brittleness-bind to it.
    await expect(host.client.listModels()).rejects.toThrow();
  });
});
