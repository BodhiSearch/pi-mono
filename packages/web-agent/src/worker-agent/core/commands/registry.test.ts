import { describe, expect, test } from 'vitest';
import { CommandRegistry } from './registry';
import type { PromptTemplateLoaderOps } from './prompt-templates';
import type { SkillLoaderOps } from './skills';
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

// ============================================================================
// Skills
// ============================================================================

function opsWithSkill(name: string, content: string): SkillLoaderOps {
  const rootDir = '/vault/.pi/skills';
  const skillDir = `${rootDir}/${name}`;
  const skillFile = `${skillDir}/SKILL.md`;
  const dirs = new Set(['/vault', '/vault/.pi', rootDir, skillDir]);
  const files = new Map<string, string>([[skillFile, content]]);

  const isDir = (path: string) => dirs.has(path);
  const isFile = (path: string) => files.has(path);

  return {
    ls: {
      stat: async path => {
        if (!isDir(path) && !isFile(path)) throw new Error(`ENOENT: ${path}`);
        return { isDirectory: () => isDir(path), isFile: () => isFile(path) };
      },
      readdir: async path => {
        if (!isDir(path)) throw new Error(`ENOTDIR: ${path}`);
        const prefix = `${path}/`;
        const children = new Set<string>();
        for (const dir of dirs) {
          if (!dir.startsWith(prefix)) continue;
          const rest = dir.slice(prefix.length);
          const firstSlash = rest.indexOf('/');
          children.add(firstSlash === -1 ? rest : rest.slice(0, firstSlash));
        }
        for (const file of files.keys()) {
          if (!file.startsWith(prefix)) continue;
          const rest = file.slice(prefix.length);
          const firstSlash = rest.indexOf('/');
          children.add(firstSlash === -1 ? rest : rest.slice(0, firstSlash));
        }
        return Array.from(children);
      },
    },
    read: {
      readFile: async path => {
        const value = files.get(path);
        if (value === undefined) throw new Error(`ENOENT: ${path}`);
        return new TextEncoder().encode(value);
      },
    },
  };
}

describe('CommandRegistry skills', () => {
  const skillContent = `---
name: hello
description: says hello
---
# Hello

Run the script.`;

  test('loadSkillsFromVault exposes /skill:<name> in list()', async () => {
    const registry = new CommandRegistry();
    await registry.loadSkillsFromVault(opsWithSkill('hello', skillContent), '/vault');
    const listed = registry.list();
    const skill = listed.find(c => c.name === 'skill:hello');
    expect(skill).toMatchObject({
      name: 'skill:hello',
      description: 'says hello',
      source: 'skill',
      disableModelInvocation: false,
    });
  });

  test('expandSkill reads SKILL.md and wraps body in <skill> block', async () => {
    const registry = new CommandRegistry();
    const ops = opsWithSkill('hello', skillContent);
    await registry.loadSkillsFromVault(ops, '/vault');
    const expanded = await registry.expandSkill('/skill:hello Alice', ops.read);
    expect(expanded).toContain('<skill name="hello" location="/vault/.pi/skills/hello/SKILL.md">');
    expect(expanded).toContain('References are relative to /vault/.pi/skills/hello.');
    expect(expanded).toContain('# Hello');
    expect(expanded).toContain('Run the script.');
    expect(expanded.trimEnd().endsWith('Alice')).toBe(true);
  });

  test('expandSkill returns unchanged text for unknown skills', async () => {
    const registry = new CommandRegistry();
    const ops = opsWithSkill('hello', skillContent);
    await registry.loadSkillsFromVault(ops, '/vault');
    expect(await registry.expandSkill('/skill:missing', ops.read)).toBe('/skill:missing');
  });

  test('expandSkill passes through non-skill text', async () => {
    const registry = new CommandRegistry();
    const ops = opsWithSkill('hello', skillContent);
    await registry.loadSkillsFromVault(ops, '/vault');
    expect(await registry.expandSkill('hello there', ops.read)).toBe('hello there');
    expect(await registry.expandSkill('/greet Alice', ops.read)).toBe('/greet Alice');
  });

  test('clearSkills drops skills but keeps prompts', async () => {
    const registry = new CommandRegistry();
    await registry.loadPromptsFromVault(opsWithTemplate('Hello $1'), '/vault');
    await registry.loadSkillsFromVault(opsWithSkill('hello', skillContent), '/vault');
    expect(registry.getSkills()).toHaveLength(1);
    expect(registry.getPromptTemplates()).toHaveLength(1);
    registry.clearSkills();
    expect(registry.getSkills()).toEqual([]);
    expect(registry.getPromptTemplates()).toHaveLength(1);
  });

  test('clearAll drops both', async () => {
    const registry = new CommandRegistry();
    await registry.loadPromptsFromVault(opsWithTemplate('Hello $1'), '/vault');
    await registry.loadSkillsFromVault(opsWithSkill('hello', skillContent), '/vault');
    registry.clearAll();
    expect(registry.list().length).toBe(BUILTIN_SLASH_COMMANDS.length);
  });
});
