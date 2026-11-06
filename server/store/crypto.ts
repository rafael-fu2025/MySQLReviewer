import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { DATA_DIR, KEY_FILE, ensureDataDirs } from '../config';
import { ensureRestrictedDirectory, restrictFileAccess } from './json-store';

const VERSION = 'v1';
let cachedKey: Buffer | null = null;

async function getKey(): Promise<Buffer> {
  if (cachedKey) return cachedKey;
  ensureDataDirs();
  try {
    const raw = (await fs.readFile(KEY_FILE, 'utf8')).trim();
    const key = Buffer.from(raw, 'base64');
    if (key.length !== 32) throw new Error('Invalid local encryption key length.');
    cachedKey = key;
    // Tighten a key file that was created before the restriction was applied.
    await restrictFileAccess(KEY_FILE);
    return key;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== 'ENOENT') throw error;
    const key = crypto.randomBytes(32);
    // The master key decrypts every stored database password and AI key:
    // restrict the data directory first so the file inherits a private ACL.
    await ensureRestrictedDirectory(DATA_DIR);
    await fs.writeFile(KEY_FILE, key.toString('base64'), { mode: 0o600 });
    await restrictFileAccess(KEY_FILE);
    cachedKey = key;
    return key;
  }
}

export async function encryptSecret(plain: string): Promise<string> {
  if (!plain) return '';
  const key = await getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString('base64'),
    tag.toString('base64'),
    encrypted.toString('base64'),
  ].join(':');
}

export async function decryptSecret(payload: string | null | undefined): Promise<string | null> {
  if (!payload) return null;
  if (!payload.startsWith(`${VERSION}:`)) return payload;
  const [, ivB64, tagB64, dataB64] = payload.split(':');
  if (!ivB64 || !tagB64 || !dataB64) return null;
  try {
    const key = await getKey();
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(dataB64, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    return null;
  }
}

export function maskSecret(value: string | null | undefined, visible = 4): string | null {
  if (!value) return null;
  if (value.length <= visible) return '••••';
  return `••••${value.slice(-visible)}`;
}
