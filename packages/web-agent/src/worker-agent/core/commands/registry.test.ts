import { describe, expect, test } from 'vitest';
import { CommandRegistry } from './registry';
import type { PromptTemplateLoaderOps } from './prompt-templates';
import { BUILTIN_SLASH_COMMANDS } from './slash-commands';

function opsWithTemplate(content: string): PromptTemplateLoaderOps {
  const files: Record<string, string> = { 'greet.md': content };
  return {
    ls: {
      readdir: async path => {
        if (path === '/vault/.pi/prompts') return Object.keys(files);
        throw new Error(`ENOENT: ${path}`);
      },
      stat: async path => {
        if (path === '/vault/.pi/prompts') {
          return { isDirectory: () => true, isFile: () => false };
        }
        const name = path.slice(path.lastIndexOf('/') + 1);
        if (name in files) return { isDirectory: () => false, isFile: () => true };
        throw new Error(`ENOENT: ${path}`);
      },
    },
    read: {
      readFile: async path => {
        const name = path.slice(path.lastIndexOf('/') + 1);
        if (!(name in files)) throw new Error(`ENOENT: ${path}`);
        return new TextEncoder().encode(files[name]);
      },
    },
  };
}

describe('CommandRegistry', () => {
  test('list() returns builtins even with no templates loaded', () => {
    const registry = new CommandRegistry();
    const listed = registry.list();
    expect(listed.length).toBe(BUILTIN_SLASH_COMMANDS.length);
    expect(listed.every(c => c.source === 'builtin')).toBe(true);
  });

  test('loadPromptsFromVault appends templates after builtins', async () => {
    const registry = new CommandRegistry();
    await registry.loadPromptsFromVault(
      opsWithTemplate('---\ndescription: hi\n---\nHello $1'),
      '/vault'
    );
    const listed = registry.list();
    expect(listed.length).toBe(BUILTIN_SLASH_COMMANDS.length + 1);
    const greet = listed.find(c => c.name === 'greet');
    expect(greet).toMatchObject({ name: 'greet', description: 'hi', source: 'prompt' });
  });

  test('clearPrompts removes loaded templates but keeps builtins', async () => {
    const registry = new CommandRegistry();
    await registry.loadPromptsFromVault(opsWithTemplate('body'), '/vault');
    expect(registry.list().length).toBeGreaterThan(BUILTIN_SLASH_COMMANDS.length);
    registry.clearPrompts();
    expect(registry.list().length).toBe(BUILTIN_SLASH_COMMANDS.length);
  });

  test('expand() substitutes args against a loaded template', async () => {
    const registry = new CommandRegistry();
    await registry.loadPromptsFromVault(opsWithTemplate('Hello $1'), '/vault');
    expect(registry.expand('/greet World')).toBe('Hello World');
  });

  test('expand() returns text unchanged for unknown commands', () => {
    const registry = new CommandRegistry();
    expect(registry.expand('/unknown args')).toBe('/unknown args');
  });

  test('expand() returns plain text unchanged', () => {
    const registry = new CommandRegistry();
    expect(registry.expand('hello world')).toBe('hello world');
  });

  test('findTemplate() locates loaded templates', async () => {
    const registry = new CommandRegistry();
    await registry.loadPromptsFromVault(opsWithTemplate('body'), '/vault');
    expect(registry.findTemplate('greet')?.name).toBe('greet');
    expect(registry.findTemplate('missing')).toBeNull();
  });

  test('reload replaces templates with the latest scan', async () => {
    const registry = new CommandRegistry();
    await registry.loadPromptsFromVault(opsWithTemplate('v1'), '/vault');
    expect(registry.findTemplate('greet')?.content).toBe('v1');
    await registry.loadPromptsFromVault(opsWithTemplate('v2'), '/vault');
    expect(registry.findTemplate('greet')?.content).toBe('v2');
  });
});
