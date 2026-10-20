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

export function detectXampp(): { path: string; port: number | null; version: string | null } | null {
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
