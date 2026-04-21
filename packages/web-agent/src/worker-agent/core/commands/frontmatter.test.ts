import { describe, expect, test } from 'vitest';
import { parseFrontmatter } from './frontmatter';

describe('parseFrontmatter', () => {
  test('returns empty frontmatter for files without a delimiter block', () => {
    const { frontmatter, body } = parseFrontmatter('just body text\nno frontmatter');
    expect(frontmatter).toEqual({});
    expect(body).toBe('just body text\nno frontmatter');
  });

  test('parses simple key/value pairs', () => {
    const raw = `---
description: Greet the user by name
argument-hint: <name>
---
Hello $1`;
    const { frontmatter, body } = parseFrontmatter(raw);
    expect(frontmatter).toEqual({
      description: 'Greet the user by name',
      'argument-hint': '<name>',
    });
    expect(body).toBe('Hello $1');
  });

  test('strips single and double quoted values', () => {
    const raw = `---
description: "quoted double"
argument-hint: 'quoted single'
---
body`;
    const { frontmatter } = parseFrontmatter(raw);
    expect(frontmatter.description).toBe('quoted double');
    expect(frontmatter['argument-hint']).toBe('quoted single');
  });

  test('ignores comments and blank lines inside the block', () => {
    const raw = `---
# a comment
description: ok

argument-hint: y
---
body`;
    const { frontmatter } = parseFrontmatter(raw);
    expect(frontmatter).toEqual({ description: 'ok', 'argument-hint': 'y' });
  });

  test('handles CRLF newlines', () => {
    const raw = `---\r\ndescription: hi\r\n---\r\nbody line`;
    const { frontmatter, body } = parseFrontmatter(raw);
    expect(frontmatter.description).toBe('hi');
    expect(body).toBe('body line');
  });

  test('returns empty frontmatter when the block has no closing delimiter', () => {
    const raw = `---
description: unterminated
not closed`;
    const { frontmatter, body } = parseFrontmatter(raw);
    expect(frontmatter).toEqual({});
    expect(body).toBe(raw);
  });

  test('leaves keys without a colon alone', () => {
    const raw = `---
plainline
description: valid
---
body`;
    const { frontmatter } = parseFrontmatter(raw);
    expect(frontmatter).toEqual({ description: 'valid' });
  });
});
