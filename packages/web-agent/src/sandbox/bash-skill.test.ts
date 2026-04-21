import { describe, expect, test } from 'vitest';
import { parseBashSkillCommand } from './bash-skill';

describe('parseBashSkillCommand', () => {
  test('accepts `node <path>.js` under .pi/skills', () => {
    const result = parseBashSkillCommand(
      'node /vault/.pi/skills/hello-world/hello.js Alice',
      '/vault'
    );
    expect(result).toEqual({
      scriptPath: '/vault/.pi/skills/hello-world/hello.js',
      args: ['Alice'],
    });
  });

  test('accepts `./<path>.js` under .pi/skills, resolved to vault mount', () => {
    const result = parseBashSkillCommand('./.pi/skills/foo/foo.js a b', '/vault');
    expect(result).toEqual({
      scriptPath: '/vault/.pi/skills/foo/foo.js',
      args: ['a', 'b'],
    });
  });

  test('accepts plain `<path>.js` form', () => {
    const result = parseBashSkillCommand('.pi/skills/foo/foo.js', '/vault');
    expect(result).toEqual({
      scriptPath: '/vault/.pi/skills/foo/foo.js',
      args: [],
    });
  });

  test('rejects commands outside .pi/skills', () => {
    const result = parseBashSkillCommand('node /vault/evil.js', '/vault');
    expect(result).toHaveProperty('error');
  });

  test('rejects non-js invocations', () => {
    expect(parseBashSkillCommand('ls -la', '/vault')).toHaveProperty('error');
    expect(parseBashSkillCommand('python script.py', '/vault')).toHaveProperty('error');
    expect(parseBashSkillCommand('', '/vault')).toHaveProperty('error');
  });

  test('respects quoted args', () => {
    const result = parseBashSkillCommand(
      'node /vault/.pi/skills/hi/hi.js "quoted arg" tail',
      '/vault'
    );
    expect(result).toEqual({
      scriptPath: '/vault/.pi/skills/hi/hi.js',
      args: ['quoted arg', 'tail'],
    });
  });

  test('rejects when script path does not end in .js', () => {
    const result = parseBashSkillCommand('node /vault/.pi/skills/foo/README.md', '/vault');
    expect(result).toHaveProperty('error');
  });
});
