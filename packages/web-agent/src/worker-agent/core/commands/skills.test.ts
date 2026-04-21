/**
 * Tests for the browser-native skills loader.
 *
 * Uses the same in-memory filesystem seam as
 * `prompt-templates.test.ts` — a tiny fake of `SkillLoaderOps` keyed by
 * absolute path. Focused on behaviour coding-agent relies on: name
 * validation, description-required rule, `disable-model-invocation`
 * exclusion from prompt output, collision handling, and
 * `formatSkillsForPrompt` shape.
 */

import { describe, expect, test } from 'vitest';
import {
  formatSkillsForPrompt,
  loadSkillsFromVault,
  stripSkillFrontmatter,
  type SkillLoaderOps,
} from './skills';

interface FsTree {
  /** Absolute paths to either file contents (string) or directory marker (null). */
  [absPath: string]: string | null;
}

function buildOps(tree: FsTree): SkillLoaderOps {
  const isDir = (path: string): boolean => tree[path] === null;
  const isFile = (path: string): boolean => typeof tree[path] === 'string';
  const exists = (path: string): boolean => path in tree;

  return {
    ls: {
      stat: async path => {
        if (!exists(path)) throw new Error(`ENOENT: ${path}`);
        return {
          isDirectory: () => isDir(path),
          isFile: () => isFile(path),
        };
      },
      readdir: async path => {
        if (!exists(path) || !isDir(path)) throw new Error(`ENOTDIR: ${path}`);
        const prefix = path.endsWith('/') ? path : `${path}/`;
        const children = new Set<string>();
        for (const key of Object.keys(tree)) {
          if (!key.startsWith(prefix)) continue;
          const rest = key.slice(prefix.length);
          if (!rest) continue;
          const firstSlash = rest.indexOf('/');
          children.add(firstSlash === -1 ? rest : rest.slice(0, firstSlash));
        }
        return Array.from(children);
      },
    },
    read: {
      readFile: async path => {
        const value = tree[path];
        if (typeof value !== 'string') throw new Error(`ENOENT: ${path}`);
        return new TextEncoder().encode(value);
      },
    },
  };
}

const validSkill = `---
name: hello-world
description: Says hello to someone
---
Run node hello.js with a name.`;

describe('loadSkillsFromVault', () => {
  test('returns empty result when skills dir missing', async () => {
    const ops = buildOps({ '/vault': null });
    const result = await loadSkillsFromVault(ops, '/vault');
    expect(result).toEqual({ skills: [], diagnostics: [] });
  });

  test('loads a valid skill', async () => {
    const ops = buildOps({
      '/vault': null,
      '/vault/.pi': null,
      '/vault/.pi/skills': null,
      '/vault/.pi/skills/hello-world': null,
      '/vault/.pi/skills/hello-world/SKILL.md': validSkill,
    });
    const result = await loadSkillsFromVault(ops, '/vault');
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0]).toMatchObject({
      name: 'hello-world',
      description: 'Says hello to someone',
      filePath: '/vault/.pi/skills/hello-world/SKILL.md',
      baseDir: '/vault/.pi/skills/hello-world',
      disableModelInvocation: false,
    });
    expect(result.diagnostics).toEqual([]);
  });

  test('name mismatch with parent dir emits warning but still loads', async () => {
    const ops = buildOps({
      '/vault': null,
      '/vault/.pi': null,
      '/vault/.pi/skills': null,
      '/vault/.pi/skills/hello-world': null,
      '/vault/.pi/skills/hello-world/SKILL.md': `---
name: other-name
description: Mismatched
---
body`,
    });
    const result = await loadSkillsFromVault(ops, '/vault');
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0].name).toBe('other-name');
    expect(result.diagnostics.some(d => d.message.includes('does not match parent'))).toBe(true);
  });

  test('missing description rejects the skill', async () => {
    const ops = buildOps({
      '/vault': null,
      '/vault/.pi': null,
      '/vault/.pi/skills': null,
      '/vault/.pi/skills/empty': null,
      '/vault/.pi/skills/empty/SKILL.md': `---
name: empty
---
body`,
    });
    const result = await loadSkillsFromVault(ops, '/vault');
    expect(result.skills).toEqual([]);
    expect(result.diagnostics.some(d => d.message.includes('description is required'))).toBe(true);
  });

  test('disable-model-invocation flag is captured', async () => {
    const ops = buildOps({
      '/vault': null,
      '/vault/.pi': null,
      '/vault/.pi/skills': null,
      '/vault/.pi/skills/hidden': null,
      '/vault/.pi/skills/hidden/SKILL.md': `---
name: hidden
description: only invokable explicitly
disable-model-invocation: true
---
body`,
    });
    const result = await loadSkillsFromVault(ops, '/vault');
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0].disableModelInvocation).toBe(true);
  });

  test('name collision keeps first, diagnostics record the loser', async () => {
    const ops = buildOps({
      '/vault': null,
      '/vault/.pi': null,
      '/vault/.pi/skills': null,
      '/vault/.pi/skills/a': null,
      '/vault/.pi/skills/a/SKILL.md': `---
name: dup
description: first
---
body`,
      '/vault/.pi/skills/b': null,
      '/vault/.pi/skills/b/SKILL.md': `---
name: dup
description: second
---
body`,
    });
    const result = await loadSkillsFromVault(ops, '/vault');
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0].description).toBe('first');
    expect(result.diagnostics.some(d => d.type === 'collision')).toBe(true);
  });

  test('sorts skills alphabetically by name', async () => {
    const ops = buildOps({
      '/vault': null,
      '/vault/.pi': null,
      '/vault/.pi/skills': null,
      '/vault/.pi/skills/zebra': null,
      '/vault/.pi/skills/zebra/SKILL.md': `---
name: zebra
description: z
---
`,
      '/vault/.pi/skills/apple': null,
      '/vault/.pi/skills/apple/SKILL.md': `---
name: apple
description: a
---
`,
    });
    const result = await loadSkillsFromVault(ops, '/vault');
    expect(result.skills.map(s => s.name)).toEqual(['apple', 'zebra']);
  });

  test('skips dotfiles and node_modules directories', async () => {
    const ops = buildOps({
      '/vault': null,
      '/vault/.pi': null,
      '/vault/.pi/skills': null,
      '/vault/.pi/skills/.hidden': null,
      '/vault/.pi/skills/.hidden/SKILL.md': `---
name: hidden
description: should not load
---
`,
      '/vault/.pi/skills/node_modules': null,
      '/vault/.pi/skills/node_modules/pkg': null,
      '/vault/.pi/skills/node_modules/pkg/SKILL.md': `---
name: pkg
description: should not load
---
`,
    });
    const result = await loadSkillsFromVault(ops, '/vault');
    expect(result.skills).toEqual([]);
  });
});

describe('formatSkillsForPrompt', () => {
  test('returns empty string for no visible skills', () => {
    expect(formatSkillsForPrompt([])).toBe('');
    expect(
      formatSkillsForPrompt([
        {
          name: 'hidden',
          description: 'd',
          filePath: '/p',
          baseDir: '/',
          disableModelInvocation: true,
        },
      ])
    ).toBe('');
  });

  test('emits XML block excluding disableModelInvocation skills', () => {
    const output = formatSkillsForPrompt([
      {
        name: 'alpha',
        description: 'First',
        filePath: '/vault/.pi/skills/alpha/SKILL.md',
        baseDir: '/vault/.pi/skills/alpha',
        disableModelInvocation: false,
      },
      {
        name: 'beta',
        description: 'Second & more',
        filePath: '/vault/.pi/skills/beta/SKILL.md',
        baseDir: '/vault/.pi/skills/beta',
        disableModelInvocation: false,
      },
      {
        name: 'hidden',
        description: 'not shown',
        filePath: '/vault/.pi/skills/hidden/SKILL.md',
        baseDir: '/vault/.pi/skills/hidden',
        disableModelInvocation: true,
      },
    ]);
    expect(output).toContain('<available_skills>');
    expect(output).toContain('<name>alpha</name>');
    expect(output).toContain('<description>First</description>');
    expect(output).toContain('<description>Second &amp; more</description>');
    expect(output).not.toContain('hidden');
  });
});

describe('stripSkillFrontmatter', () => {
  test('removes frontmatter block, returns body', () => {
    const raw = `---
name: x
description: y
---
Hello world`;
    expect(stripSkillFrontmatter(raw)).toBe('Hello world');
  });

  test('returns input unchanged when no frontmatter', () => {
    expect(stripSkillFrontmatter('no frontmatter here')).toBe('no frontmatter here');
  });
});
