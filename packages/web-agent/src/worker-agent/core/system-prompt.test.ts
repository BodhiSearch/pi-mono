import { describe, expect, test } from 'vitest';
import { buildSystemPrompt } from './system-prompt';
import type { Skill } from './commands/skills';

const skill = (overrides: Partial<Skill> = {}): Skill => ({
  name: 'hello',
  description: 'say hi',
  filePath: '/vault/.pi/skills/hello/SKILL.md',
  baseDir: '/vault/.pi/skills/hello',
  disableModelInvocation: false,
  ...overrides,
});

describe('buildSystemPrompt', () => {
  test('returns default body with cwd + date when no skills', () => {
    const out = buildSystemPrompt({ cwd: '/vault', now: new Date('2026-01-02T00:00:00Z') });
    expect(out).toContain('You are pi');
    expect(out).toContain('Current date: 2026-01-02');
    expect(out).toContain('Current working directory: /vault');
    expect(out).not.toContain('<available_skills>');
  });

  test('appends skills when hasReadTool and skills present', () => {
    const out = buildSystemPrompt({
      cwd: '/vault',
      skills: [skill()],
      hasReadTool: true,
    });
    expect(out).toContain('<available_skills>');
    expect(out).toContain('<name>hello</name>');
  });

  test('omits skills when hasReadTool=false', () => {
    const out = buildSystemPrompt({ cwd: '/vault', skills: [skill()], hasReadTool: false });
    expect(out).not.toContain('<available_skills>');
  });

  test('customPrompt replaces default body but still gets footer', () => {
    const out = buildSystemPrompt({
      customPrompt: 'You are a test bot.',
      cwd: '/vault',
      skills: [skill()],
    });
    expect(out.startsWith('You are a test bot.')).toBe(true);
    expect(out).toContain('<available_skills>');
    expect(out).toContain('Current working directory: /vault');
  });

  test('omits cwd line when not provided', () => {
    const out = buildSystemPrompt({});
    expect(out).not.toContain('Current working directory:');
  });

  test('hidden skills (disableModelInvocation) are dropped from prompt', () => {
    const out = buildSystemPrompt({
      cwd: '/vault',
      skills: [skill({ disableModelInvocation: true })],
    });
    expect(out).not.toContain('<available_skills>');
  });
});
