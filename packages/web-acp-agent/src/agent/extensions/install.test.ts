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
});
