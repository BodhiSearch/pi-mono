import { createTarGzip } from 'nanotar';
import { describe, expect, it } from 'vitest';
import type { ExtensionsWriteFs } from './extensions-fs';
import { installExtensionFromNpm, localExtensionDirName, parseNpmPackageSpec } from './install';

describe('parseNpmPackageSpec', () => {
  it('parses a bare package name', () => {
    expect(parseNpmPackageSpec('pi-hello-world')).toEqual({ name: 'pi-hello-world' });
  });

  it('parses `<name>@<version>`', () => {
    expect(parseNpmPackageSpec('pi-hello-world@1.2.3')).toEqual({
      name: 'pi-hello-world',
      version: '1.2.3',
    });
  });

  it('parses scoped packages', () => {
    expect(parseNpmPackageSpec('@scope/foo')).toEqual({ name: '@scope/foo' });
    expect(parseNpmPackageSpec('@scope/foo@2.0.0')).toEqual({
      name: '@scope/foo',
      version: '2.0.0',
    });
  });

  it('strips an optional `npm:` prefix', () => {
    expect(parseNpmPackageSpec('npm:pi-foo@0.1.0')).toEqual({
      name: 'pi-foo',
      version: '0.1.0',
    });
  });

  it('throws on empty input', () => {
    expect(() => parseNpmPackageSpec('   ')).toThrow(/empty/);
  });
});

describe('localExtensionDirName', () => {
  it('mirrors a flat layout for plain and scoped packages', () => {
    expect(localExtensionDirName('pi-foo', '0.0.1')).toBe('pi-foo@0.0.1');
    expect(localExtensionDirName('@scope/foo', '1.2.3')).toBe('scope__foo@1.2.3');
  });
});

describe('installExtensionFromNpm', () => {
  function memWriteFs(): ExtensionsWriteFs & { files: Map<string, string> } {
    const files = new Map<string, string>();
    return {
      files,
      async mkdir(path) {
        files.set(`${path}/.dir`, '');
      },
      async writeFile(path, contents) {
        files.set(path, contents);
      },
      async rm(path) {
        for (const key of [...files.keys()]) {
          if (key === path || key.startsWith(`${path}/`)) files.delete(key);
        }
      },
    };
  }

  async function buildTarball(
    pkg: Record<string, string>
  ): Promise<{ url: string; bytes: Uint8Array }> {
    const entries = Object.entries(pkg).map(([name, data]) => ({ name: `package/${name}`, data }));
    const bytes = await createTarGzip(entries);
    return { url: 'https://registry.example/test/-/pi-hello-world-1.0.0.tgz', bytes };
  }

  function toBody(bytes: Uint8Array): ArrayBuffer {
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  }

  it('fetches metadata, unpacks the tarball, and writes index.js + package.json', async () => {
    const writeFs = memWriteFs();
    const { url: tarballUrl, bytes } = await buildTarball({
      'package.json': JSON.stringify({
        name: 'pi-hello-world',
        version: '1.0.0',
        module: 'index.mjs',
      }),
      'index.mjs':
        "export default function (pi) { pi.registerCommand('hi', { handler: () => 'hi' }); }\n",
    });
    const fetchImpl: typeof fetch = async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === 'https://registry.example/pi-hello-world') {
        return new Response(
          JSON.stringify({
            'dist-tags': { latest: '1.0.0' },
            versions: { '1.0.0': { version: '1.0.0', dist: { tarball: tarballUrl } } },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      if (url === tarballUrl) {
        return new Response(toBody(bytes), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    };

    const result = await installExtensionFromNpm({
      spec: 'pi-hello-world',
      agentWdMount: 'wiki',
      writeFs,
      registryUrl: 'https://registry.example',
      fetchImpl,
    });

    expect(result.name).toBe('pi-hello-world');
    expect(result.version).toBe('1.0.0');
    expect(result.extensionName).toBe('pi-hello-world@1.0.0');
    expect(result.installPath).toBe('/mnt/wiki/.pi/extensions/pi-hello-world@1.0.0');
    expect(writeFs.files.get(`${result.installPath}/index.js`)).toContain('registerCommand');
    expect(writeFs.files.get(`${result.installPath}/package.json`)).toContain(
      '"name":"pi-hello-world"'
    );
  });

  it('prefers `pi.extensions[0]` over `module` / `main`', async () => {
    const writeFs = memWriteFs();
    const { url: tarballUrl, bytes } = await buildTarball({
      'package.json': JSON.stringify({
        name: 'pi-multi',
        version: '0.1.0',
        main: 'main.js',
        module: 'esm.mjs',
        pi: { extensions: ['custom-entry.js'] },
      }),
      'main.js': '// not used',
      'esm.mjs': '// not used',
      'custom-entry.js': 'export default function (pi) { /* custom */ }\n',
    });
    const fetchImpl: typeof fetch = async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === 'https://registry.example/pi-multi') {
        return new Response(
          JSON.stringify({
            'dist-tags': { latest: '0.1.0' },
            versions: { '0.1.0': { version: '0.1.0', dist: { tarball: tarballUrl } } },
          }),
          { status: 200 }
        );
      }
      if (url === tarballUrl) return new Response(toBody(bytes), { status: 200 });
      return new Response('not found', { status: 404 });
    };

    const result = await installExtensionFromNpm({
      spec: 'pi-multi',
      agentWdMount: 'wiki',
      writeFs,
      registryUrl: 'https://registry.example',
      fetchImpl,
    });

    expect(writeFs.files.get(`${result.installPath}/index.js`)).toContain('custom');
  });

  it('rejects a version string containing path traversal sequences', async () => {
    const writeFs = memWriteFs();
    const { url: tarballUrl, bytes } = await buildTarball({
      'package.json': JSON.stringify({
        name: 'pi-evil',
        version: '../../etc/evil',
        main: 'index.js',
      }),
      'index.js': '// evil',
    });
    const fetchImpl: typeof fetch = async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('pi-evil')) {
        return new Response(
          JSON.stringify({
            'dist-tags': { latest: '1.0.0' },
            versions: { '1.0.0': { version: '1.0.0', dist: { tarball: tarballUrl } } },
          }),
          { status: 200 }
        );
      }
      if (url === tarballUrl) return new Response(toBody(bytes), { status: 200 });
      return new Response('not found', { status: 404 });
    };

    await expect(
      installExtensionFromNpm({
        spec: 'pi-evil',
        agentWdMount: 'wiki',
        writeFs,
        registryUrl: 'https://registry.example',
        fetchImpl,
      })
    ).rejects.toThrow(/unsafe version string/);
    // No files must have been written
    expect(writeFs.files.size).toBe(0);
  });

  it('rejects a non-https tarball URL returned by the registry', async () => {
    const writeFs = memWriteFs();
    const httpTarballUrl = 'http://evil.example.com/pi-hello-world-1.0.0.tgz';
    const { bytes } = await buildTarball({
      'package.json': JSON.stringify({
        name: 'pi-hello-world',
        version: '1.0.0',
        main: 'index.js',
      }),
      'index.js': '// ok',
    });
    const fetchImpl: typeof fetch = async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('pi-hello-world')) {
        return new Response(
          JSON.stringify({
            'dist-tags': { latest: '1.0.0' },
            versions: { '1.0.0': { version: '1.0.0', dist: { tarball: httpTarballUrl } } },
          }),
          { status: 200 }
        );
      }
      // The http tarball URL must never be reached
      if (url === httpTarballUrl) return new Response(toBody(bytes), { status: 200 });
      return new Response('not found', { status: 404 });
    };

    await expect(
      installExtensionFromNpm({
        spec: 'pi-hello-world',
        agentWdMount: 'wiki',
        writeFs,
        registryUrl: 'https://registry.example',
        fetchImpl,
      })
    ).rejects.toThrow(/tarball URL.*must use https/);
    expect(writeFs.files.size).toBe(0);
  });

  it('rejects packages with no entry hint', async () => {
    const writeFs = memWriteFs();
    const { url: tarballUrl, bytes } = await buildTarball({
      'package.json': JSON.stringify({ name: 'pi-bad', version: '0.0.1' }),
      'index.js': '// orphaned',
    });
    const fetchImpl: typeof fetch = async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === 'https://registry.example/pi-bad') {
        return new Response(
          JSON.stringify({
            'dist-tags': { latest: '0.0.1' },
            versions: { '0.0.1': { dist: { tarball: tarballUrl } } },
          }),
          { status: 200 }
        );
      }
      if (url === tarballUrl) return new Response(toBody(bytes), { status: 200 });
      return new Response('not found', { status: 404 });
    };

    await expect(
      installExtensionFromNpm({
        spec: 'pi-bad',
        agentWdMount: 'wiki',
        writeFs,
        registryUrl: 'https://registry.example',
        fetchImpl,
      })
    ).rejects.toThrow(/declares no entry/);
  });

  it('rejects when registry metadata fetch returns non-OK', async () => {
    const writeFs = memWriteFs();
    const fetchImpl: typeof fetch = async () =>
      new Response('boom', { status: 500, statusText: 'Internal Server Error' });

    await expect(
      installExtensionFromNpm({
        spec: 'pi-hello-world',
        agentWdMount: 'wiki',
        writeFs,
        registryUrl: 'https://registry.example',
        fetchImpl,
      })
    ).rejects.toThrow(/registry metadata fetch failed/);
    expect(writeFs.files.size).toBe(0);
  });

  it('rejects when tarball fetch returns non-OK', async () => {
    const writeFs = memWriteFs();
    const tarballUrl = 'https://registry.example/test/-/pi-hello-world-1.0.0.tgz';
    const fetchImpl: typeof fetch = async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === 'https://registry.example/pi-hello-world') {
        return new Response(
          JSON.stringify({
            'dist-tags': { latest: '1.0.0' },
            versions: { '1.0.0': { version: '1.0.0', dist: { tarball: tarballUrl } } },
          }),
          { status: 200 }
        );
      }
      if (url === tarballUrl) return new Response('nope', { status: 502 });
      return new Response('not found', { status: 404 });
    };

    await expect(
      installExtensionFromNpm({
        spec: 'pi-hello-world',
        agentWdMount: 'wiki',
        writeFs,
        registryUrl: 'https://registry.example',
        fetchImpl,
      })
    ).rejects.toThrow(/tarball fetch failed/);
    expect(writeFs.files.size).toBe(0);
  });

  it('reinstall over existing dir replaces stale content', async () => {
    const writeFs = memWriteFs();
    const installRoot = '/mnt/wiki/.pi/extensions/pi-hello-world@1.0.0';
    // Pre-populate stale content
    writeFs.files.set(`${installRoot}/index.js`, 'STALE_INDEX');
    writeFs.files.set(`${installRoot}/package.json`, 'STALE_MANIFEST');
    writeFs.files.set(`${installRoot}/leftover.txt`, 'should be wiped');

    const { url: tarballUrl, bytes } = await buildTarball({
      'package.json': JSON.stringify({
        name: 'pi-hello-world',
        version: '1.0.0',
        main: 'index.js',
      }),
      'index.js': '// fresh content\n',
    });
    const fetchImpl: typeof fetch = async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === 'https://registry.example/pi-hello-world') {
        return new Response(
          JSON.stringify({
            'dist-tags': { latest: '1.0.0' },
            versions: { '1.0.0': { version: '1.0.0', dist: { tarball: tarballUrl } } },
          }),
          { status: 200 }
        );
      }
      if (url === tarballUrl) return new Response(toBody(bytes), { status: 200 });
      return new Response('not found', { status: 404 });
    };

    await installExtensionFromNpm({
      spec: 'pi-hello-world',
      agentWdMount: 'wiki',
      writeFs,
      registryUrl: 'https://registry.example',
      fetchImpl,
    });

    // Stale leftover gone; fresh entries written.
    expect(writeFs.files.has(`${installRoot}/leftover.txt`)).toBe(false);
    expect(writeFs.files.get(`${installRoot}/index.js`)).toBe('// fresh content\n');
    expect(writeFs.files.get(`${installRoot}/package.json`)).toContain('"name":"pi-hello-world"');
  });

  it('round-trips a scoped package into a flat install dir', async () => {
    const writeFs = memWriteFs();
    const { url: tarballUrl, bytes } = await buildTarball({
      'package.json': JSON.stringify({
        name: '@scope/pi-foo',
        version: '1.0.0',
        main: 'index.js',
      }),
      'index.js': '// scoped\n',
    });
    const fetchImpl: typeof fetch = async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === 'https://registry.example/%40scope%2fpi-foo') {
        return new Response(
          JSON.stringify({
            'dist-tags': { latest: '1.0.0' },
            versions: { '1.0.0': { version: '1.0.0', dist: { tarball: tarballUrl } } },
          }),
          { status: 200 }
        );
      }
      if (url === tarballUrl) return new Response(toBody(bytes), { status: 200 });
      return new Response('not found', { status: 404 });
    };

    const result = await installExtensionFromNpm({
      spec: '@scope/pi-foo@1.0.0',
      agentWdMount: 'wiki',
      writeFs,
      registryUrl: 'https://registry.example',
      fetchImpl,
    });

    expect(result.name).toBe('@scope/pi-foo');
    expect(result.extensionName).toBe('scope__pi-foo@1.0.0');
    expect(result.installPath).toBe('/mnt/wiki/.pi/extensions/scope__pi-foo@1.0.0');
  });

  it('rejects a tarball with malformed package.json', async () => {
    const writeFs = memWriteFs();
    const entries = [{ name: 'package/package.json', data: 'not json at all' }];
    const bytes = await createTarGzip(entries);
    const tarballUrl = 'https://registry.example/test/-/pi-bad-1.0.0.tgz';
    const fetchImpl: typeof fetch = async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === 'https://registry.example/pi-bad') {
        return new Response(
          JSON.stringify({
            'dist-tags': { latest: '1.0.0' },
            versions: { '1.0.0': { version: '1.0.0', dist: { tarball: tarballUrl } } },
          }),
          { status: 200 }
        );
      }
      if (url === tarballUrl) return new Response(toBody(bytes), { status: 200 });
      return new Response('not found', { status: 404 });
    };

    await expect(
      installExtensionFromNpm({
        spec: 'pi-bad',
        agentWdMount: 'wiki',
        writeFs,
        registryUrl: 'https://registry.example',
        fetchImpl,
      })
    ).rejects.toThrow();
    expect(writeFs.files.size).toBe(0);
  });

  it('rejects when entry file is declared but missing from tarball', async () => {
    const writeFs = memWriteFs();
    const { url: tarballUrl, bytes } = await buildTarball({
      'package.json': JSON.stringify({
        name: 'pi-missing-entry',
        version: '1.0.0',
        main: 'index.js',
      }),
      // Note: no `index.js` file in the tarball
      'README.md': '# pi-missing-entry',
    });
    const fetchImpl: typeof fetch = async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === 'https://registry.example/pi-missing-entry') {
        return new Response(
          JSON.stringify({
            'dist-tags': { latest: '1.0.0' },
            versions: { '1.0.0': { version: '1.0.0', dist: { tarball: tarballUrl } } },
          }),
          { status: 200 }
        );
      }
      if (url === tarballUrl) return new Response(toBody(bytes), { status: 200 });
      return new Response('not found', { status: 404 });
    };

    await expect(
      installExtensionFromNpm({
        spec: 'pi-missing-entry',
        agentWdMount: 'wiki',
        writeFs,
        registryUrl: 'https://registry.example',
        fetchImpl,
      })
    ).rejects.toThrow(/was not present in the tarball/);
    expect(writeFs.files.size).toBe(0);
  });

  it('cleans up the install dir if writeFile fails mid-install', async () => {
    // memWriteFs whose second writeFile throws — index.js succeeds, package.json fails.
    const files = new Map<string, string>();
    let writeCount = 0;
    const writeFs: ExtensionsWriteFs & { files: Map<string, string> } = {
      files,
      async mkdir(path) {
        files.set(`${path}/.dir`, '');
      },
      async writeFile(path, contents) {
        writeCount += 1;
        if (writeCount === 2) throw new Error('disk full');
        files.set(path, contents);
      },
      async rm(path) {
        for (const key of [...files.keys()]) {
          if (key === path || key.startsWith(`${path}/`)) files.delete(key);
        }
      },
    };

    const { url: tarballUrl, bytes } = await buildTarball({
      'package.json': JSON.stringify({
        name: 'pi-hello-world',
        version: '1.0.0',
        main: 'index.js',
      }),
      'index.js': '// content\n',
    });
    const fetchImpl: typeof fetch = async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === 'https://registry.example/pi-hello-world') {
        return new Response(
          JSON.stringify({
            'dist-tags': { latest: '1.0.0' },
            versions: { '1.0.0': { version: '1.0.0', dist: { tarball: tarballUrl } } },
          }),
          { status: 200 }
        );
      }
      if (url === tarballUrl) return new Response(toBody(bytes), { status: 200 });
      return new Response('not found', { status: 404 });
    };

    await expect(
      installExtensionFromNpm({
        spec: 'pi-hello-world',
        agentWdMount: 'wiki',
        writeFs,
        registryUrl: 'https://registry.example',
        fetchImpl,
      })
    ).rejects.toThrow(/disk full/);
    // After cleanup nothing should remain.
    expect(writeFs.files.size).toBe(0);
  });
});
