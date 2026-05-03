import { describe, expect, it } from 'vitest';
import { FrontMatterError, parseFrontMatter } from './front-matter';

describe('parseFrontMatter', () => {
  it('parses a well-formed front-matter block', () => {
    const raw = [
      '---',
      'description: Greet someone',
      'argument-hint: <name>',
      '---',
      'Hello $1!',
    ].join('\n');
    const r = parseFrontMatter(raw);
    expect(r.frontMatter).toEqual({ description: 'Greet someone', 'argument-hint': '<name>' });
    expect(r.body).toBe('Hello $1!');
  });

  it('returns empty front-matter when the file has no fence', () => {
    const r = parseFrontMatter('Plain markdown body, no fence.\n');
    expect(r.frontMatter).toEqual({});
    expect(r.body).toBe('Plain markdown body, no fence.\n');
  });

  it('strips a leading BOM before checking the fence', () => {
    const r = parseFrontMatter('\uFEFF---\ndescription: ok\n---\nbody');
    expect(r.frontMatter).toEqual({ description: 'ok' });
    expect(r.body).toBe('body');
  });

  it('treats unterminated front-matter as a body-only file', () => {
    const r = parseFrontMatter('---\ndescription: oops\nno-closing-fence\n');
    expect(r.frontMatter).toEqual({});
    expect(r.body).toBe('---\ndescription: oops\nno-closing-fence\n');
  });

  it('handles CRLF line endings', () => {
    const raw = '---\r\ndescription: cr\r\n---\r\nBody';
    const r = parseFrontMatter(raw);
    expect(r.frontMatter).toEqual({ description: 'cr' });
    expect(r.body).toBe('Body');
  });

  it('unquotes single- and double-quoted scalars', () => {
    const r = parseFrontMatter('---\nfoo: "bar baz"\nbaz: \'qux\'\n---\n');
    expect(r.frontMatter).toEqual({ foo: 'bar baz', baz: 'qux' });
  });

  it('rejects list values', () => {
    expect(() => parseFrontMatter('---\nargs: [a, b]\n---\n')).toThrow(FrontMatterError);
  });

  it('rejects map values', () => {
    expect(() => parseFrontMatter('---\nthing: { a: 1 }\n---\n')).toThrow(FrontMatterError);
  });

  it('rejects multi-line block scalars', () => {
    expect(() => parseFrontMatter('---\ntext: |\n---\n')).toThrow(FrontMatterError);
  });

  it('rejects malformed keys', () => {
    expect(() => parseFrontMatter('---\n9bad: x\n---\n')).toThrow(FrontMatterError);
  });

  it('rejects empty values', () => {
    expect(() => parseFrontMatter('---\nfoo:\n---\n')).toThrow(FrontMatterError);
  });

  it('skips comment and blank lines inside the block', () => {
    const r = parseFrontMatter('---\n# a comment\n\nfoo: bar\n---\n');
    expect(r.frontMatter).toEqual({ foo: 'bar' });
  });

  it('tolerates trailing whitespace on the fence lines', () => {
    const r = parseFrontMatter('---   \nfoo: bar\n--- \nbody');
    expect(r.frontMatter).toEqual({ foo: 'bar' });
    expect(r.body).toBe('body');
  });
});
