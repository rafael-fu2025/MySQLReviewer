import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.MYLENS_DATA_DIR = mkdtempSync(join(tmpdir(), 'mylens-tests-'));
process.env.MYLENS_PORT = '0';
