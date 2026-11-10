import { describe, expect, it } from 'vitest';

// The server module opens a listening socket when it is imported directly.
process.env.MYLENS_NO_LISTEN = '1';

const { CONTENT_SECURITY_POLICY, tokenMatches } = await import('../server/index');

describe('the Content-Security-Policy served with every response', () => {
  it('locks the document down to its own origin', () => {
    expect(CONTENT_SECURITY_POLICY).toBe(
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
        "img-src 'self' data:; font-src 'self' data:; connect-src 'self'; " +
        "object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
    );
  });

  it('never allows inline scripts', () => {
    // The built SPA loads one external bundle; model-controlled markdown must
    // not be able to run anything.
    expect(CONTENT_SECURITY_POLICY).not.toMatch(/script-src[^;]*'unsafe-inline'/);
    expect(CONTENT_SECURITY_POLICY).not.toMatch(/script-src[^;]*unsafe-eval/);
  });

  it('declares every directive the app needs', () => {
    for (const directive of [
      'default-src',
      'script-src',
      'style-src',
      'img-src',
      'font-src',
      'connect-src',
      'object-src',
      'base-uri',
      'form-action',
      'frame-ancestors',
    ]) {
      expect(CONTENT_SECURITY_POLICY).toContain(`${directive} `);
    }
  });
});

describe('tokenMatches', () => {
  it('accepts the exact token and rejects everything else', () => {
    const token = 'a'.repeat(64);
    expect(tokenMatches(token, token)).toBe(true);
    expect(tokenMatches(` ${token}`, token)).toBe(false);
    expect(tokenMatches(`${token}x`, token)).toBe(false);
    expect(tokenMatches('short', token)).toBe(false);
    expect(tokenMatches('', token)).toBe(false);
  });

  it('compares mismatched lengths without leaking or throwing', () => {
    expect(tokenMatches('abc', 'abcdefgh')).toBe(false);
    expect(tokenMatches('abcdefgh', 'abc')).toBe(false);
    expect(tokenMatches('', '')).toBe(true);
  });
});
