import fs from 'node:fs';
import path from 'node:path';
import { APP_NAME, APP_VERSION } from '../shared/types';

export { APP_NAME, APP_VERSION };

const ROOT = path.resolve(process.cwd());

export const DATA_DIR = process.env.MYLENS_DATA_DIR
  ? path.resolve(process.env.MYLENS_DATA_DIR)
  : path.join(ROOT, 'data');
export const REPORTS_DIR = path.join(DATA_DIR, 'reports');
export const CLIENT_DIST = path.join(ROOT, 'dist');
export const KEY_FILE = path.join(DATA_DIR, '.secret.key');

export const HOST = process.env.MYLENS_HOST ?? '127.0.0.1';
export const PORT = clampInt(process.env.MYLENS_PORT, 8787, 1, 65_535);

export const DEV_ORIGINS = new Set([
  'http://127.0.0.1:5174',
  'http://localhost:5174',
  `http://127.0.0.1:${PORT}`,
  `http://localhost:${PORT}`,
]);

export const BODY_LIMIT = '6mb';

export function ensureDataDirs(): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
}

export function clampInt(
  value: string | number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

export function detectXampp(): {
  path: string;
  port: number | null;
  version: string | null;
} | null {
  const candidates = [
    'C:\\xampp',
    path.join(process.env.USERPROFILE ?? '', 'xampp'),
    path.join(process.env.SystemDrive ?? 'C:', 'xampp'),
  ].filter(Boolean);

  for (const candidate of candidates) {
    const props = path.join(candidate, 'properties.ini');
    if (!fs.existsSync(props)) continue;
    let port: number | null = null;
    let version: string | null = null;
    try {
      const text = fs.readFileSync(props, 'utf8');
      const portMatch = text.match(/^\s*mysql_port\s*=\s*(\d+)\s*$/im);
      if (portMatch) port = Number.parseInt(portMatch[1], 10);
      const versionMatch = text.match(/^\s*version\s*=\s*(.+)$/im);
      if (versionMatch) version = versionMatch[1].trim();
    } catch {
      // Detection is best-effort only.
    }
    return { path: candidate, port, version };
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Document storage backend                                                    */
/* -------------------------------------------------------------------------- */

export type StorageMode = 'json' | 'mysql';

export interface StorageConfig {
  /** `json` (default): one JSON file per document inside the data directory. */
  mode: StorageMode;
  mysql: {
    /** Connection URI of the MySQL server holding the documents. */
    uri: string;
    /** Schema the documents live in; created on first boot when missing. */
    database: string;
  };
}

function parseStorageMode(value: string | undefined): StorageMode {
  const normalized = value?.trim().toLowerCase();
  return normalized === 'mysql' ? 'mysql' : 'json';
}

/**
 * Where the app's own documents (users, sessions, profiles, history, ...) are
 * stored. The default keeps the local-first file behavior; `mysql` moves the
 * same JSON documents into a schema on the operator's MySQL server so accounts
 * and data survive independently of the `data/` folder.
 */
export const storageConfig: StorageConfig = {
  mode: parseStorageMode(process.env.MYLENS_STORE),
  mysql: {
    uri: process.env.MYLENS_STORE_MYSQL_URI || 'mysql://root@127.0.0.1:3306',
    database: process.env.MYLENS_STORE_MYSQL_DATABASE || 'mylens',
  },
};
