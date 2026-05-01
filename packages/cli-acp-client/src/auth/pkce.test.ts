import * as crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createPkcePair } from './pkce';

describe('createPkcePair', () => {
  it('generates a verifier of valid PKCE length', () => {
    const { verifier } = createPkcePair();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
    expect(/^[A-Za-z0-9_-]+$/.test(verifier)).toBe(true);
  });

  it('challenge is sha256(verifier) base64url-encoded', () => {
    const { verifier, challenge } = createPkcePair();
    const expected = crypto
      .createHash('sha256')
      .update(verifier)
      .digest('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    expect(challenge).toBe(expected);
  });

  it('state is unique per call', () => {
    const a = createPkcePair();
    const b = createPkcePair();
    expect(a.state).not.toBe(b.state);
    expect(a.verifier).not.toBe(b.verifier);
  });
});
