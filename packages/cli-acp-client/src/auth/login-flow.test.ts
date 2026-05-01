import { describe, expect, it } from 'vitest';
import { buildAuthorizeUrl } from './login-flow';
import { APP_CLIENT_ID } from './config';
import { createPkcePair } from './pkce';

describe('buildAuthorizeUrl', () => {
  it('renders all required PKCE params with the static + access-request scope', () => {
    const pkce = createPkcePair();
    const url = buildAuthorizeUrl({
      authServerUrl: 'https://idp.example.com/realms/bodhi',
      accessRequestId: 'abc123',
      pkce,
      redirectUri: 'http://localhost:53217/callback',
    });
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe(
      'https://idp.example.com/realms/bodhi/protocol/openid-connect/auth'
    );
    expect(parsed.searchParams.get('response_type')).toBe('code');
    expect(parsed.searchParams.get('redirect_uri')).toBe('http://localhost:53217/callback');
    expect(parsed.searchParams.get('code_challenge')).toBe(pkce.challenge);
    expect(parsed.searchParams.get('code_challenge_method')).toBe('S256');
    expect(parsed.searchParams.get('state')).toBe(pkce.state);
    expect(parsed.searchParams.get('client_id')).toBe(APP_CLIENT_ID);
    const scope = parsed.searchParams.get('scope') ?? '';
    expect(scope.split(' ')).toEqual(
      expect.arrayContaining(['openid', 'email', 'profile', 'roles', 'access_request:abc123'])
    );
  });

  it('uses the server-supplied access_request_scope verbatim when present', () => {
    const pkce = createPkcePair();
    const url = buildAuthorizeUrl({
      authServerUrl: 'https://idp.example.com/realms/bodhi/',
      accessRequestId: 'abc',
      accessRequestScope: 'access_request:abc-DEADBEEF',
      pkce,
      redirectUri: 'http://localhost:1/callback',
    });
    const parsed = new URL(url);
    const scope = parsed.searchParams.get('scope') ?? '';
    expect(scope.split(' ')).toContain('access_request:abc-DEADBEEF');
    expect(scope.split(' ')).not.toContain('access_request:abc');
  });
});
