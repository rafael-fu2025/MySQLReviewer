import { describe, expect, it } from 'vitest';

import { isBootstrapRequestAllowed } from '../server/bootstrap-origin';

const EXPECTED = 'http://192.168.1.11:8787';
const ALLOWED = new Set([
  'http://127.0.0.1:8787',
  'http://localhost:8787',
  'http://127.0.0.1:5174',
]);

function gate(overrides: {
  origin?: string | null;
  secFetchSite?: string | null;
  accept?: string | null;
}): boolean {
  return isBootstrapRequestAllowed({
    origin: overrides.origin ?? null,
    secFetchSite: overrides.secFetchSite ?? null,
    accept: overrides.accept ?? null,
    expectedOrigin: EXPECTED,
    allowedOrigins: ALLOWED,
  });
}

describe('bootstrap origin gate', () => {
  it('allows a same-origin fetch (desktop browsers always send this)', () => {
    expect(gate({ secFetchSite: 'same-origin', accept: 'application/json' })).toBe(true);
    expect(gate({ secFetchSite: 'same-origin' })).toBe(true);
  });

  it('allows an Origin that matches the request’s own host or the dev allowlist', () => {
    expect(gate({ origin: EXPECTED, accept: '*/*' })).toBe(true);
    expect(gate({ origin: 'http://127.0.0.1:5174', accept: '*/*' })).toBe(true);
  });

  it('rejects a mismatched cross-origin Origin', () => {
    expect(gate({ origin: 'https://evil.example', secFetchSite: 'cross-site' })).toBe(false);
    expect(gate({ origin: 'https://evil.example' })).toBe(false);
  });

  it('rejects an explicitly cross-site fetch even with a JSON Accept header', () => {
    expect(gate({ secFetchSite: 'cross-site', accept: 'application/json' })).toBe(false);
    expect(gate({ secFetchSite: 'same-site', accept: 'application/json' })).toBe(false);
  });

  it('allows metadata-less requests that carry the app’s own JSON signature', () => {
    // OEM mobile browsers and proxy modes strip Fetch-Metadata and Origin on
    // same-origin requests; the SPA always asks for application/json.
    expect(gate({ accept: 'application/json' })).toBe(true);
    expect(gate({ secFetchSite: 'none', accept: 'application/json' })).toBe(true);
    expect(gate({ accept: 'application/json, text/plain, */*' })).toBe(true);
  });

  it('still rejects curl-style clients that ask for anything', () => {
    expect(gate({ accept: '*/*' })).toBe(false);
    expect(gate({})).toBe(false);
  });
});
