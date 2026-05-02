import { describe, expect, it } from 'vitest';
import { resolveIsDev } from './dev-flag';

describe('resolveIsDev', () => {
  it('defaults to true when env var is unset', () => {
    expect(resolveIsDev(undefined)).toBe(true);
  });

  it.each(['0', 'false', 'no', 'off', '', '   '])('opts out for %j', input => {
    expect(resolveIsDev(input)).toBe(false);
  });

  it.each(['FALSE', 'False', 'Off', ' OFF ', '0'])(
    'is case-insensitive and trim-aware: %j → false',
    input => {
      expect(resolveIsDev(input)).toBe(false);
    }
  );

  it.each(['1', 'true', 'yes', 'on', 'anything-else', 'TRUE'])(
    'is opt-in by default for non-falsy values: %j → true',
    input => {
      expect(resolveIsDev(input)).toBe(true);
    }
  );
});
