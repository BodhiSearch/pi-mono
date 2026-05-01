import * as crypto from 'node:crypto';

/**
 * PKCE helpers for OAuth 2.1 (S256). Code verifier is a base64url-encoded
 * random buffer (43-128 chars per RFC 7636); challenge is its SHA-256 also
 * base64url-encoded.
 *
 * `state` is an opaque CSRF token returned by the authorization server in
 * the redirect query — we generate one per attempt and reject the callback
 * if it does not match.
 */

export interface PkcePair {
  verifier: string;
  challenge: string;
  state: string;
}

export function createPkcePair(): PkcePair {
  const verifier = base64UrlEncode(crypto.randomBytes(32));
  const challenge = base64UrlEncode(crypto.createHash('sha256').update(verifier).digest());
  const state = base64UrlEncode(crypto.randomBytes(16));
  return { verifier, challenge, state };
}

function base64UrlEncode(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
