import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret, maskSecret } from '../server/store/crypto';

describe('secret storage', () => {
  it('encrypts and decrypts without exposing the plaintext', async () => {
    const encrypted = await encryptSecret('hunter2');
    expect(encrypted).not.toContain('hunter2');
    expect(encrypted.startsWith('v1:')).toBe(true);
    expect(await decryptSecret(encrypted)).toBe('hunter2');
  });

  it('masks keys for display', () => {
    expect(maskSecret('sk-abcdefgh')).toBe('••••efgh');
    expect(maskSecret(null)).toBeNull();
    expect(maskSecret('abc')).toBe('••••');
  });
});
