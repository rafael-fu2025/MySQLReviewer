import type { RowDataPacket } from 'mysql2/promise';
import type {
  CharsetInfo,
  CreateDatabaseInput,
  CreateDatabaseResult,
  DatabaseInfo,
} from '../../shared/types';
import { SYSTEM_SCHEMAS } from '../../shared/types';
import { AppError } from '../errors';
import { withConnection } from './manager';
import { addDatabaseToScope, getStoredProfile } from '../store/profiles';
import { generateGrantSql } from './grants';

interface Row extends RowDataPacket {
  [key: string]: unknown;
}

const IDENTIFIER = /^[A-Za-z0-9_]{1,64}$/;

function validateName(name: string): string {
  const trimmed = name.trim();
  if (!IDENTIFIER.test(trimmed)) {
    throw new AppError(
      'VALIDATION',
      'Database name must be 1–64 characters using letters, digits, and underscores.',
    );
  }
  if (SYSTEM_SCHEMAS.includes(trimmed.toLowerCase())) {
    throw new AppError('VALIDATION', 'That name is reserved for a MySQL system schema.');
  }
  return trimmed;
}

export async function listCharsets(profileId: string): Promise<CharsetInfo[]> {
  return withConnection(profileId, async (conn) => {
    const [rows] = await conn.query<Row[]>(
      `SELECT CHARACTER_SET_NAME, COLLATION_NAME, IS_DEFAULT
       FROM information_schema.COLLATIONS
       ORDER BY CHARACTER_SET_NAME, COLLATION_NAME`,
    );
    const map = new Map<string, { name: string; isDefault: boolean }[]>();
    for (const row of rows) {
      const charset = String(row.CHARACTER_SET_NAME ?? '');
      if (!charset) continue;
      const list = map.get(charset) ?? [];
      list.push({
        name: String(row.COLLATION_NAME ?? ''),
        isDefault: String(row.IS_DEFAULT ?? '').toUpperCase() === 'YES',
      });
      map.set(charset, list);
    }
    return Array.from(map.entries()).map(([charset, collations]) => ({
      charset,
      collations,
    }));
  });
}

export async function createDatabase(
  profileId: string,
  input: CreateDatabaseInput,
): Promise<CreateDatabaseResult> {
  const name = validateName(input.name);
  const charset = input.charset?.trim();
  const collation = input.collation?.trim();
  if (!charset || !collation) {
    throw new AppError('VALIDATION', 'Charset and collation are required.');
  }

  return withConnection(profileId, async (conn) => {
    const [collationRows] = await conn.query<Row[]>(
      `SELECT CHARACTER_SET_NAME
       FROM information_schema.COLLATIONS
       WHERE COLLATION_NAME = ? AND CHARACTER_SET_NAME = ?
       LIMIT 1`,
      [collation, charset],
    );
    if (collationRows.length === 0) {
      throw new AppError(
        'VALIDATION',
        `Collation "${collation}" does not belong to charset "${charset}" on this server.`,
      );
    }

    const [existing] = await conn.query<Row[]>(
      `SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ? LIMIT 1`,
      [name],
    );
    if (existing.length > 0) {
      throw new AppError('DATABASE_EXISTS', `Database "${name}" already exists.`, 409);
    }

    await conn.query('CREATE DATABASE ?? CHARACTER SET ?? COLLATE ??', [
      name,
      charset,
      collation,
    ]);

    const [dbRows] = await conn.query<Row[]>(
      `SELECT SCHEMA_NAME, DEFAULT_COLLATION_NAME
       FROM information_schema.SCHEMATA
       WHERE SCHEMA_NAME = ?`,
      [name],
    );
    const database: DatabaseInfo = {
      name,
      isSystem: false,
      tableCount: 0,
      viewCount: 0,
      sizeBytes: 0,
      collation: dbRows[0]?.DEFAULT_COLLATION_NAME
        ? String(dbRows[0].DEFAULT_COLLATION_NAME)
        : collation,
    };

    let scopeUpdated = false;
    const profile = await getStoredProfile(profileId);
    if (profile.databaseScope === 'selected' && input.addToScope !== false) {
      await addDatabaseToScope(profileId, name);
      scopeUpdated = true;
    }

    const grant = generateGrantSql({
      user: 'mylens_app',
      host: 'localhost',
      databases: [name],
      privileges: ['SELECT', 'SHOW VIEW'],
    });

    return {
      database,
      scopeUpdated,
      grantSql: grant.sql,
    };
  });
}
