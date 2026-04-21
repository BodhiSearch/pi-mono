import { describe, expect, test } from 'vitest';
import { loadExtensionFromSource, loadExtensionsFromVault } from './loader';
import type { ExtensionLoaderOps, ModuleImporter } from './loader';

/**
 * Node-friendly importer: transforms the source into a data: URL so
 * `import()` can resolve it without depending on browser-only
 * `URL.createObjectURL`. Production uses the Blob-URL importer inside
 * the worker; the e2e suite exercises that path end-to-end.
 */
const nodeImporter: ModuleImporter = async code => {
  const url = `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
  return (await import(/* @vite-ignore */ url)) as Record<string, unknown>;
};

function encoder() {
  return new TextEncoder();
}

interface FakeFs {
  dirs: Set<string>;
  files: Map<string, string>;
}

function makeFakeFs(): FakeFs {
  return { dirs: new Set(['/vault', '/vault/.pi', '/vault/.pi/extensions']), files: new Map() };
}

function opsForFs(fs: FakeFs): ExtensionLoaderOps {
  const isDir = (p: string) => fs.dirs.has(p);
  const isFile = (p: string) => fs.files.has(p);
  return {
    ls: {
      stat: async (path: string) => {
        if (!isDir(path) && !isFile(path)) throw new Error(`ENOENT: ${path}`);
        return { isDirectory: () => isDir(path), isFile: () => isFile(path) };
      },
      readdir: async (path: string) => {
        if (!isDir(path)) throw new Error(`ENOTDIR: ${path}`);
        const prefix = `${path}/`;
        const children = new Set<string>();
        for (const dir of fs.dirs) {
          if (!dir.startsWith(prefix)) continue;
          const rest = dir.slice(prefix.length);
          const firstSlash = rest.indexOf('/');
          children.add(firstSlash === -1 ? rest : rest.slice(0, firstSlash));
        }
        for (const file of fs.files.keys()) {
          if (!file.startsWith(prefix)) continue;
          const rest = file.slice(prefix.length);
          const firstSlash = rest.indexOf('/');
          children.add(firstSlash === -1 ? rest : rest.slice(0, firstSlash));
        }
        return Array.from(children);
      },
    },
    read: {
      readFile: async (path: string) => {
        const value = fs.files.get(path);
        if (value === undefined) throw new Error(`ENOENT: ${path}`);
        return encoder().encode(value);
      },
    },
  };
}

function addExtension(fs: FakeFs, name: string, entry: string): void {
  const dir = `/vault/.pi/extensions/${name}`;
  fs.dirs.add(dir);
  fs.files.set(`${dir}/index.js`, entry);
}

describe('loadExtensionsFromVault', () => {
  test('returns empty when extensions directory does not exist', async () => {
    const fs = { dirs: new Set(['/vault']), files: new Map() };
    const ops = opsForFs(fs);
    const result = await loadExtensionsFromVault(ops, '/vault');
    expect(result.extensions).toEqual([]);
    expect(result.descriptors).toEqual([]);
  });

  test('loads a single index.js extension and captures its registrations', async () => {
    const fs = makeFakeFs();
    addExtension(
      fs,
      'hello',
      `export default function (pi) {
         pi.registerCommand('hello', {
           description: 'says hi',
           handler: () => {},
         });
         pi.on('before_agent_start', event => ({ systemPrompt: event.systemPrompt + '!' }));
       }`
    );
    const result = await loadExtensionsFromVault(opsForFs(fs), '/vault', {
      importModule: nodeImporter,
    });
    expect(result.extensions).toHaveLength(1);
    const ext = result.extensions[0]!;
    expect(ext.name).toBe('hello');
    expect(ext.commands.get('hello')?.description).toBe('says hi');
    expect(ext.handlers.get('before_agent_start')?.length).toBe(1);
    expect(result.descriptors[0]).toMatchObject({
      name: 'hello',
      enabled: true,
      loaded: true,
    });
  });

  test('surfaces syntax errors as descriptor.error without aborting the scan', async () => {
    const fs = makeFakeFs();
    addExtension(fs, 'broken', 'export default function (pi {');
    addExtension(fs, 'ok', 'export default function (pi) {}');
    const result = await loadExtensionsFromVault(opsForFs(fs), '/vault', {
      importModule: nodeImporter,
    });
    expect(result.extensions).toHaveLength(1);
    expect(result.extensions[0]!.name).toBe('ok');
    const broken = result.descriptors.find(d => d.name === 'broken')!;
    expect(broken.loaded).toBe(false);
    expect(broken.error).toBeTruthy();
  });

  test('skips extensions explicitly disabled via enabledState', async () => {
    const fs = makeFakeFs();
    addExtension(
      fs,
      'off',
      'export default function (pi) { pi.registerCommand("off", { handler: () => {} }); }'
    );
    const result = await loadExtensionsFromVault(opsForFs(fs), '/vault', {
      enabledState: { off: false },
      importModule: nodeImporter,
    });
    expect(result.extensions).toHaveLength(0);
    expect(result.descriptors[0]).toMatchObject({ name: 'off', enabled: false, loaded: false });
  });

  test('records extensions missing a default export as broken', async () => {
    const fs = makeFakeFs();
    addExtension(fs, 'no-default', 'export const x = 1;');
    const result = await loadExtensionsFromVault(opsForFs(fs), '/vault', {
      importModule: nodeImporter,
    });
    expect(result.extensions).toHaveLength(0);
    const broken = result.descriptors[0]!;
    expect(broken.loaded).toBe(false);
    expect(broken.error).toMatch(/default function/);
  });

  test('propagates package.json manifest name/description when present', async () => {
    const fs = makeFakeFs();
    const dir = '/vault/.pi/extensions/pkg';
    fs.dirs.add(dir);
    fs.files.set(
      `${dir}/package.json`,
      JSON.stringify({
        name: 'nice-name',
        description: 'from manifest',
        version: '1.2.3',
        pi: { extensions: ['./entry.js'] },
      })
    );
    fs.files.set(`${dir}/entry.js`, 'export default function (pi) {}');
    const result = await loadExtensionsFromVault(opsForFs(fs), '/vault', {
      importModule: nodeImporter,
    });
    expect(result.extensions[0]?.name).toBe('nice-name');
    expect(result.extensions[0]?.description).toBe('from manifest');
    expect(result.extensions[0]?.version).toBe('1.2.3');
  });
});

describe('loadExtensionFromSource', () => {
  test('loads source string and runs the factory', async () => {
    const result = await loadExtensionFromSource(
      `export default function (pi) {
         pi.registerCommand('foo', { handler: () => {} });
       }`,
      'foo',
      { importModule: nodeImporter }
    );
    expect('extension' in result).toBe(true);
    if ('extension' in result) {
      expect(result.extension.commands.get('foo')).toBeDefined();
    }
  });

  test('surfaces factory throws', async () => {
    const result = await loadExtensionFromSource(
      `export default function () { throw new Error('boom'); }`,
      'broken',
      { importModule: nodeImporter }
    );
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toBe('boom');
    }
  });
});
