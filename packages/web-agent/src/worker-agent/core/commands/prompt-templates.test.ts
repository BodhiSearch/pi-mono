/**
 * Tests for argument parsing, placeholder substitution, template
 * expansion, and the vault-backed loader.
 *
 * Port of the core cases from
 * `packages/coding-agent/test/prompt-templates.test.ts`, trimmed to
 * the browser-relevant subset and adapted to the in-memory
 * `PromptTemplateLoaderOps` seam.
 */

import { describe, expect, test } from 'vitest';
import {
  expandPromptTemplate,
  loadPromptTemplatesFromDir,
  parseCommandArgs,
  substituteArgs,
  type PromptTemplateLoaderOps,
} from './prompt-templates';
import type { PromptTemplate } from './types';

// ============================================================================
// substituteArgs
// ============================================================================

describe('substituteArgs', () => {
  test('replaces $ARGUMENTS with all args joined', () => {
    expect(substituteArgs('Test: $ARGUMENTS', ['a', 'b', 'c'])).toBe('Test: a b c');
  });

  test('replaces $@ identically to $ARGUMENTS', () => {
    const args = ['foo', 'bar'];
    expect(substituteArgs('Test: $@', args)).toBe(substituteArgs('Test: $ARGUMENTS', args));
  });

  test('does NOT recursively substitute patterns in arg values', () => {
    expect(substituteArgs('$ARGUMENTS', ['$1', '$ARGUMENTS'])).toBe('$1 $ARGUMENTS');
    expect(substituteArgs('$@', ['$100', '$1'])).toBe('$100 $1');
  });

  test('handles positional placeholders', () => {
    expect(substituteArgs('$1 $2 $3', ['a', 'b', 'c'])).toBe('a b c');
  });

  test('out-of-range positional placeholders become empty strings', () => {
    expect(substituteArgs('$1 $2 $3 $4', ['a', 'b'])).toBe('a b  ');
  });

  test('multi-digit positional placeholders work', () => {
    const args = Array.from({ length: 15 }, (_, i) => `v${i}`);
    expect(substituteArgs('$10 $12', args)).toBe('v9 v11');
  });

  test('$0 is out-of-range (1-indexed convention)', () => {
    expect(substituteArgs('$0', ['a'])).toBe('');
  });

  test('handles bash slice ${@:N}', () => {
    expect(substituteArgs('${@:2}', ['a', 'b', 'c'])).toBe('b c');
  });

  test('handles bash slice with length ${@:N:L}', () => {
    expect(substituteArgs('${@:2:2}', ['a', 'b', 'c', 'd'])).toBe('b c');
  });

  test('slice is processed before simple $@', () => {
    expect(substituteArgs('${@:2} vs $@', ['a', 'b', 'c'])).toBe('b c vs a b c');
  });

  test('case-sensitive: $arguments is literal', () => {
    expect(substituteArgs('$arguments $ARGUMENTS', ['a'])).toBe('$arguments a');
  });

  test('empty args produce empty expansions', () => {
    expect(substituteArgs('Test: $ARGUMENTS', [])).toBe('Test: ');
    expect(substituteArgs('Test: $1', [])).toBe('Test: ');
  });

  test('handles unicode', () => {
    expect(substituteArgs('$ARGUMENTS', ['日本語', '🎉'])).toBe('日本語 🎉');
  });
});

// ============================================================================
// parseCommandArgs
// ============================================================================

describe('parseCommandArgs', () => {
  test('splits on whitespace', () => {
    expect(parseCommandArgs('one two three')).toEqual(['one', 'two', 'three']);
  });

  test('respects double-quoted strings', () => {
    expect(parseCommandArgs('one "two three" four')).toEqual(['one', 'two three', 'four']);
  });

  test('respects single-quoted strings', () => {
    expect(parseCommandArgs("'a b' c")).toEqual(['a b', 'c']);
  });

  test('tabs are valid separators', () => {
    expect(parseCommandArgs('a\tb\tc')).toEqual(['a', 'b', 'c']);
  });

  test('returns empty array for empty input', () => {
    expect(parseCommandArgs('')).toEqual([]);
  });

  test('collapses runs of whitespace', () => {
    expect(parseCommandArgs('  a    b  ')).toEqual(['a', 'b']);
  });
});

// ============================================================================
// expandPromptTemplate
// ============================================================================

function makeTemplate(partial: Partial<PromptTemplate> & { name: string }): PromptTemplate {
  return {
    description: '',
    content: '',
    filePath: `/vault/.pi/prompts/${partial.name}.md`,
    ...partial,
  };
}

describe('expandPromptTemplate', () => {
  const templates: PromptTemplate[] = [
    makeTemplate({ name: 'greet', content: 'Hello $1' }),
    makeTemplate({ name: 'summary', content: 'Summarize: $ARGUMENTS' }),
  ];

  test('returns text unchanged when it does not start with /', () => {
    expect(expandPromptTemplate('hello world', templates)).toBe('hello world');
  });

  test('expands a known template with positional args', () => {
    expect(expandPromptTemplate('/greet Alice', templates)).toBe('Hello Alice');
  });

  test('expands with quoted args', () => {
    expect(expandPromptTemplate('/summary "the codebase"', templates)).toBe(
      'Summarize: the codebase'
    );
  });

  test('unknown template falls through', () => {
    expect(expandPromptTemplate('/unknown foo', templates)).toBe('/unknown foo');
  });

  test('template with no args preserved', () => {
    expect(expandPromptTemplate('/greet', templates)).toBe('Hello ');
  });
});

// ============================================================================
// loadPromptTemplatesFromDir
// ============================================================================

interface FakeNode {
  files: Record<string, string>;
}

function buildOps(tree: Record<string, FakeNode | string>): PromptTemplateLoaderOps {
  // tree keys: directories (map to FakeNode) or files (map to string content).
  const readdir = async (path: string): Promise<string[]> => {
    const node = tree[path];
    if (!node || typeof node === 'string') {
      const err = new Error(`ENOENT: ${path}`);
      throw err;
    }
    return Object.keys(node.files);
  };
  const stat = async (path: string) => {
    if (path in tree) {
      const node = tree[path];
      if (typeof node === 'string') {
        return { isDirectory: () => false, isFile: () => true };
      }
      return { isDirectory: () => true, isFile: () => false };
    }
    // A file inside a listed directory
    const lastSlash = path.lastIndexOf('/');
    const parent = path.slice(0, lastSlash);
    const name = path.slice(lastSlash + 1);
    const dir = tree[parent];
    if (dir && typeof dir !== 'string' && name in dir.files) {
      return { isDirectory: () => false, isFile: () => true };
    }
    throw new Error(`ENOENT: ${path}`);
  };
  const readFile = async (path: string): Promise<Uint8Array> => {
    const lastSlash = path.lastIndexOf('/');
    const parent = path.slice(0, lastSlash);
    const name = path.slice(lastSlash + 1);
    const dir = tree[parent];
    if (!dir || typeof dir === 'string' || !(name in dir.files)) {
      throw new Error(`ENOENT: ${path}`);
    }
    return new TextEncoder().encode(dir.files[name]);
  };
  return {
    ls: { readdir, stat },
    read: { readFile },
  };
}

describe('loadPromptTemplatesFromDir', () => {
  test('returns [] when the directory is missing', async () => {
    const ops = buildOps({});
    const templates = await loadPromptTemplatesFromDir('/vault/.pi/prompts', ops);
    expect(templates).toEqual([]);
  });

  test('loads .md files with frontmatter and body', async () => {
    const ops = buildOps({
      '/vault/.pi/prompts': {
        files: {
          'greet.md': `---
description: Greet someone
argument-hint: <name>
---
Hello $1`,
          'notes.md': `just body without frontmatter`,
          'ignored.txt': 'not markdown',
        },
      },
    });
    const templates = await loadPromptTemplatesFromDir('/vault/.pi/prompts', ops);
    expect(templates).toHaveLength(2);
    const greet = templates.find(t => t.name === 'greet');
    expect(greet).toMatchObject({
      name: 'greet',
      description: 'Greet someone',
      argumentHint: '<name>',
      content: 'Hello $1',
      filePath: '/vault/.pi/prompts/greet.md',
    });
    const notes = templates.find(t => t.name === 'notes');
    expect(notes?.description).toBe('just body without frontmatter');
  });

  test('sorts entries alphabetically by name', async () => {
    const ops = buildOps({
      '/vault/.pi/prompts': {
        files: {
          'z.md': 'z',
          'a.md': 'a',
          'm.md': 'm',
        },
      },
    });
    const templates = await loadPromptTemplatesFromDir('/vault/.pi/prompts', ops);
    expect(templates.map(t => t.name)).toEqual(['a', 'm', 'z']);
  });
});
