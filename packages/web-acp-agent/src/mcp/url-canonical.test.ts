import { describe, expect, it } from 'vitest';
import { canonicalizeMcpUrl, deriveSlugFromUrl } from './url-canonical';

describe('canonicalizeMcpUrl', () => {
  it('lowercases the host and drops the default https port', () => {
    expect(canonicalizeMcpUrl('HTTPS://Mcp.Example.COM:443/path')).toBe(
      'https://mcp.example.com/path'
    );
  });

  it('preserves non-default ports', () => {
    expect(canonicalizeMcpUrl('https://mcp.example.com:8443/path')).toBe(
      'https://mcp.example.com:8443/path'
    );
  });

  it('preserves query string and fragment', () => {
    expect(canonicalizeMcpUrl('https://mcp.example.com/mcp?token=abc#x')).toBe(
      'https://mcp.example.com/mcp?token=abc#x'
    );
  });

  it('trims surrounding whitespace before parsing', () => {
    expect(canonicalizeMcpUrl('   https://mcp.example.com/mcp   ')).toBe(
      'https://mcp.example.com/mcp'
    );
  });

  it('returns null for non-URL input', () => {
    expect(canonicalizeMcpUrl('not-a-url')).toBeNull();
    expect(canonicalizeMcpUrl('')).toBeNull();
    expect(canonicalizeMcpUrl('   ')).toBeNull();
  });
});

describe('deriveSlugFromUrl', () => {
  it('strips the leading "mcp." subdomain and returns the next label', () => {
    expect(deriveSlugFromUrl('https://mcp.deepwiki.com/mcp')).toBe('deepwiki');
  });

  it('strips "api." and "www." subdomains too', () => {
    expect(deriveSlugFromUrl('https://api.weather.example/mcp')).toBe('weather');
    expect(deriveSlugFromUrl('https://www.everything.example/mcp')).toBe('everything');
  });

  it('keeps the full label when the host has only one meaningful segment', () => {
    expect(deriveSlugFromUrl('https://example.com/mcp')).toBe('example');
  });

  it('falls back to the last meaningful path segment for generic hosts', () => {
    expect(deriveSlugFromUrl('http://localhost:3000/servers/echo')).toBe('echo');
  });

  it('returns empty string on parse failure', () => {
    expect(deriveSlugFromUrl('not-a-url')).toBe('');
  });
});
