import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { KEY_FILE } from '../server/config';
import { mapDbError } from '../server/errors';
import { decryptSecret, encryptSecret, maskSecret } from '../server/store/crypto';
import { writeJsonAtomic } from '../server/store/json-store';

const execFileAsync = promisify(execFile);

async function icacls(target: string): Promise<string> {
  const { stdout } = await execFileAsync('icacls', [target], { windowsHide: true });
  return stdout;
}

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

describe('F-28 — the stored secrets are not readable by other local accounts', () => {
  it('restricts the master key file to the current account', async () => {
    await encryptSecret('acl-probe');
    if (process.platform === 'win32') {
      const acl = await icacls(KEY_FILE);
      expect(acl).not.toMatch(/Everyone|Authenticated Users|BUILTIN\\Users|S-1-1-0/i);
    } else {
      const stat = await fs.stat(KEY_FILE);
      expect(stat.mode & 0o777).toBe(0o600);
    }
  });

  it('removes the inherited access of a written file', async () => {
    const parent = await mkdtemp(path.join(tmpdir(), 'mylens-acl-'));
    try {
      const dir = path.join(parent, 'data');
      await fs.mkdir(dir);
      if (process.platform === 'win32') {
        // The parent lets every local account read what it contains.
        await execFileAsync('icacls', [parent, '/grant', '*S-1-1-0:(OI)(CI)(RX)'], {
          windowsHide: true,
        });
        expect(await icacls(dir)).toMatch(/Everyone|S-1-1-0/i);

        await writeJsonAtomic(path.join(dir, 'secret.json'), { secret: true });

        const acl = await icacls(path.join(dir, 'secret.json'));
        expect(acl).not.toMatch(/Everyone|Authenticated Users|BUILTIN\\Users|S-1-1-0/i);
      } else {
        await writeJsonAtomic(path.join(dir, 'secret.json'), { secret: true });
        const stat = await fs.stat(path.join(dir, 'secret.json'));
        expect(stat.mode & 0o777).toBe(0o600);
      }
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});

describe('F-22 — a database error never leaks its raw text', () => {
  it('returns safe, actionable copy for a known MySQL error', () => {
    const mapped = mapDbError({
      code: 'ER_DUP_ENTRY',
      errno: 1062,
      sqlState: '23000',
      sqlMessage: "Duplicate entry 'stored-secret-value' for key 'users.username'",
    });

    expect(mapped.code).toBe('DUPLICATE_ROW');
    expect(mapped.message).toBe(
      'That row already exists. Edit the existing row instead of inserting a second one.',
    );
    expect(mapped.message).not.toContain('stored-secret-value');
    expect(mapped.message).not.toContain('users');
    expect(mapped.details).toEqual({ code: 'ER_DUP_ENTRY' });
  });

  it('keeps the fixed message for an error code it cannot explain', () => {
    const mapped = mapDbError({
      code: 'ER_SOMETHING_UNMAPPED',
      sqlMessage: "internal detail about 'users.username'",
    });

    expect(mapped.code).toBe('MYSQL_ERROR');
    expect(mapped.message).toBe('The database rejected the statement.');
    expect(mapped.message).not.toContain('users');
    expect(mapped.details).toEqual({ code: 'ER_SOMETHING_UNMAPPED' });
  });

  it('keeps the hand-written messages of the known error codes', () => {
    expect(mapDbError({ code: 'ER_ACCESS_DENIED_ERROR' }).message).toBe(
      'Access denied. Check the username and password for this MySQL account.',
    );
    expect(mapDbError({ code: 'ER_BAD_DB_ERROR' }).code).toBe('DATABASE_NOT_FOUND');
    expect(mapDbError({ code: 'ECONNREFUSED' }).code).toBe('CONNECTION_REFUSED');
  });
});
