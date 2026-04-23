import { describe, expect, test } from 'vitest';
import { ExtensionSkillController } from './extension-skill-controller';
import { CommandRegistry } from '../core/commands';
import type { Extension, RegisteredSkill } from '../core/extensions/types';

function makeExtension(path: string, skills: RegisteredSkill[]): Extension {
  const map = new Map<string, RegisteredSkill>();
  for (const s of skills) map.set(s.name, s);
  return {
    name: path.split('/').pop() ?? 'ext',
    path,
    entryPath: `${path}/index.js`,
    handlers: new Map(),
    tools: new Map(),
    commands: new Map(),
    providers: new Map(),
    skills: map,
  };
}

describe('ExtensionSkillController', () => {
  test('setFromExtensions pushes flat list into the registry under source=extension-skill', () => {
    const registry = new CommandRegistry();
    const ctl = new ExtensionSkillController({ registry });
    ctl.setFromExtensions([
      makeExtension('/ext/a', [
        {
          name: 'nudge',
          description: 'nudge',
          body: '# Nudge',
          extensionPath: '/ext/a',
        },
        {
          name: 'stern',
          description: 'stern',
          body: '# Stern',
          extensionPath: '/ext/a',
          disableModelInvocation: true,
        },
      ]),
    ]);
    const listed = registry
      .list()
      .filter(c => c.source === 'extension-skill')
      .map(c => c.name)
      .sort();
    expect(listed).toEqual(['skill:nudge', 'skill:stern']);
    expect(ctl.list()).toHaveLength(2);
  });

  test('churn replaces the registry skills — unloaded extensions drop their skills', () => {
    const registry = new CommandRegistry();
    const ctl = new ExtensionSkillController({ registry });
    ctl.setFromExtensions([
      makeExtension('/ext/a', [
        { name: 'nudge', description: 'd', body: 'b', extensionPath: '/ext/a' },
      ]),
      makeExtension('/ext/b', [
        { name: 'other', description: 'd', body: 'b', extensionPath: '/ext/b' },
      ]),
    ]);
    expect(registry.list().filter(c => c.source === 'extension-skill')).toHaveLength(2);

    // Drop ext/b.
    ctl.setFromExtensions([
      makeExtension('/ext/a', [
        { name: 'nudge', description: 'd', body: 'b', extensionPath: '/ext/a' },
      ]),
    ]);
    const remaining = registry
      .list()
      .filter(c => c.source === 'extension-skill')
      .map(c => c.name);
    expect(remaining).toEqual(['skill:nudge']);
  });

  test('first-wins dedupe when two extensions claim the same skill name', () => {
    const registry = new CommandRegistry();
    const ctl = new ExtensionSkillController({ registry });
    ctl.setFromExtensions([
      makeExtension('/ext/a', [
        { name: 'nudge', description: 'first', body: 'body-a', extensionPath: '/ext/a' },
      ]),
      makeExtension('/ext/b', [
        { name: 'nudge', description: 'second', body: 'body-b', extensionPath: '/ext/b' },
      ]),
    ]);
    const flat = ctl.list();
    expect(flat).toHaveLength(1);
    expect(flat[0]!.extensionPath).toBe('/ext/a');
  });

  test('expandSkill uses the in-memory body for extension-contributed skills', async () => {
    const registry = new CommandRegistry();
    const ctl = new ExtensionSkillController({ registry });
    ctl.setFromExtensions([
      makeExtension('/ext/a', [
        {
          name: 'nudge',
          description: 'd',
          body: '# Nudge body',
          extensionPath: '/ext/a',
        },
      ]),
    ]);
    const expanded = await registry.expandSkill('/skill:nudge args', {
      readFile: async () => {
        throw new Error('should not hit vault');
      },
    });
    expect(expanded).toContain('# Nudge body');
    expect(expanded).toContain('location="extension:/ext/a"');
    expect(expanded).toContain('args');
  });

  test('clear drops everything from the registry', () => {
    const registry = new CommandRegistry();
    const ctl = new ExtensionSkillController({ registry });
    ctl.setFromExtensions([
      makeExtension('/ext/a', [
        { name: 'nudge', description: 'd', body: 'b', extensionPath: '/ext/a' },
      ]),
    ]);
    ctl.clear();
    expect(ctl.list()).toHaveLength(0);
    expect(registry.list().filter(c => c.source === 'extension-skill')).toHaveLength(0);
  });

  test('resolveInlineScript returns the body scoped to the extension path', () => {
    const registry = new CommandRegistry();
    const ctl = new ExtensionSkillController({ registry });
    ctl.setFromExtensions([
      makeExtension('/ext/a', [
        { name: 'hello', description: 'd', body: 'console.log(1)', extensionPath: '/ext/a' },
      ]),
      makeExtension('/ext/b', [
        { name: 'world', description: 'd', body: 'console.log(2)', extensionPath: '/ext/b' },
      ]),
    ]);
    expect(ctl.resolveInlineScript('/ext/a', 'hello')).toBe('console.log(1)');
    expect(ctl.resolveInlineScript('/ext/a', 'world')).toBeUndefined();
    expect(ctl.resolveInlineScript('/ext/missing', 'hello')).toBeUndefined();
  });
});
