import { describe, expect, it, vi, afterAll } from 'vitest';

import { randomId } from '../src/lib/uuid';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('randomId', () => {
  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it('returns a UUID v4 when crypto.randomUUID exists (secure context)', () => {
    expect(randomId()).toMatch(UUID_V4);
    expect(randomId()).not.toBe(randomId());
  });

  it('falls back to getRandomValues in insecure contexts (no randomUUID)', () => {
    // Plain-HTTP LAN sharing: `crypto.randomUUID` is undefined because the
    // page is not a secure context. getRandomValues, however, always exists.
    // The filler is deterministic per call — the v4/variant bits are re-set by
    // randomId, so the results are still valid, distinct UUIDs.
    let call = 0;
    const getRandomValues = vi.fn((bytes: Uint8Array) => {
      call += 1;
      for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i * 37 + call * 91) % 256;
      return bytes;
    });
    vi.stubGlobal('crypto', { getRandomValues });
    const first = randomId();
    const second = randomId();
    expect(first).toMatch(UUID_V4);
    expect(second).toMatch(UUID_V4);
    expect(first).not.toBe(second);
    expect(getRandomValues).toHaveBeenCalledTimes(2);
  });
});
