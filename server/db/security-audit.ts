import type { RowDataPacket } from 'mysql2/promise';
import type { CoverageItem, DbUser, GrantInfo, SecurityConfigSnapshot } from '../../shared/types';
import { SYSTEM_SCHEMAS } from '../../shared/types';
import { AppError } from '../errors';
import { withConnection } from './manager';
import { getGlobalVariables } from './metrics';

interface Row extends RowDataPacket {
  [key: string]: unknown;
}

export interface UserPrivilegeSummary {
  user: string;
  host: string;
  privileges: string[];
  grantOption: boolean;
}

export interface SecurityData {
  users: DbUser[];
  privilegeSummaries: UserPrivilegeSummary[];
  definers: string[];
  config: SecurityConfigSnapshot;
  coverage: CoverageItem[];
  generatedAt: string;
}

function str(value: unknown): string {
  return value == null ? '' : String(value);
}

function bool(value: unknown): boolean {
  const normalized = str(value).toUpperCase();
  return normalized === 'Y' || normalized === 'YES' || normalized === '1' || normalized === 'TRUE';
}

function parseGrantee(value: string): { user: string; host: string } | null {
  const match = value.match(/^'(.*)'@'(.*)'$/);
  if (!match) return null;
  return {
    user: match[1].replace(/''/g, "'"),
    host: match[2].replace(/''/g, "'"),
  };
}

async function loadUsers(profileId: string): Promise<{
  users: DbUser[];
  status: 'ran' | 'denied' | 'error';
  error?: string;
}> {
  return withConnection(profileId, async (conn) => {
    const attempt = async (sql: string): Promise<Row[]> => {
      const [rows] = await conn.query<Row[]>(sql);
      return rows;
    };

    let rows: Row[];
    let hasAuthColumn = true;
    try {
      rows = await attempt(
        `SELECT User, Host, plugin, authentication_string, Super_priv, File_priv,
                Process_priv, Grant_priv, Shutdown_priv, Create_user_priv, Reload_priv
         FROM mysql.user`,
      );
    } catch {
      try {
        hasAuthColumn = false;
        rows = await attempt(
          `SELECT User, Host, Password, Super_priv, File_priv, Process_priv,
                  Grant_priv, Shutdown_priv, Create_user_priv, Reload_priv
           FROM mysql.user`,
        );
      } catch (error) {
        return {
          users: [],
          status: 'denied',
          error: (error as Error).message,
        };
      }
    }

    return {
      users: rows.map((row) => ({
        user: str(row.User),
        host: str(row.Host),
        plugin: hasAuthColumn ? str(row.plugin) : '',
        passwordSet: hasAuthColumn
          ? str(row.authentication_string).length > 0
          : str(row.Password).length > 0,
        superPriv: bool(row.Super_priv),
        filePriv: bool(row.File_priv),
        processPriv: bool(row.Process_priv),
        grantPriv: bool(row.Grant_priv),
        shutdownPriv: bool(row.Shutdown_priv),
        createUserPriv: bool(row.Create_user_priv),
        reloadPriv: bool(row.Reload_priv),
      })),
      status: 'ran',
    };
  });
}

async function loadPrivileges(profileId: string): Promise<{
  summaries: UserPrivilegeSummary[];
  status: 'ran' | 'denied' | 'error';
  error?: string;
}> {
  try {
    const rows = await withConnection(profileId, async (conn) => {
      const [result] = await conn.query<Row[]>(
        `SELECT GRANTEE, PRIVILEGE_TYPE, IS_GRANTABLE
         FROM information_schema.USER_PRIVILEGES`,
      );
      return result;
    });
    const map = new Map<string, UserPrivilegeSummary>();
    for (const row of rows) {
      const grantee = parseGrantee(str(row.GRANTEE));
      if (!grantee) continue;
      const key = `${grantee.user}\u0000${grantee.host}`;
      const summary = map.get(key) ?? {
        user: grantee.user,
        host: grantee.host,
        privileges: [],
        grantOption: false,
      };
      const privilege = str(row.PRIVILEGE_TYPE).toUpperCase();
      if (privilege) summary.privileges.push(privilege);
      if (bool(row.IS_GRANTABLE) || privilege === 'GRANT OPTION') summary.grantOption = true;
      map.set(key, summary);
    }
    return { summaries: Array.from(map.values()), status: 'ran' };
  } catch (error) {
    return { summaries: [], status: 'denied', error: (error as Error).message };
  }
}

async function loadDefiners(profileId: string): Promise<string[]> {
  return withConnection(profileId, async (conn) => {
    const [rows] = await conn.query<Row[]>(
      `SELECT DISTINCT DEFINER AS definer FROM information_schema.ROUTINES
       WHERE ROUTINE_SCHEMA NOT IN (?, ?, ?, ?)
       UNION
       SELECT DISTINCT DEFINER AS definer FROM information_schema.VIEWS
       WHERE TABLE_SCHEMA NOT IN (?, ?, ?, ?)`,
      [...SYSTEM_SCHEMAS, ...SYSTEM_SCHEMAS],
    );
    return Array.from(
      new Set(rows.map((row) => str(row.definer)).filter((value) => value && value !== 'NULL')),
    );
  });
}

function configFromVariables(variables: Record<string, string>): SecurityConfigSnapshot {
  return {
    localInfile: variables.local_infile ?? null,
    secureFilePriv: variables.secure_file_priv ?? null,
    bindAddress: variables.bind_address ?? null,
    sqlMode: variables.sql_mode ?? null,
    skipNameResolve: variables.skip_name_resolve ?? null,
  };
}

export async function collectSecurityData(
  profileId: string,
  variables?: Record<string, string>,
): Promise<SecurityData> {
  const vars = variables ?? (await getGlobalVariables(profileId));
  const [userResult, privilegeResult, definersResult] = await Promise.allSettled([
    loadUsers(profileId),
    loadPrivileges(profileId),
    loadDefiners(profileId),
  ]);

  const userData =
    userResult.status === 'fulfilled'
      ? userResult.value
      : { users: [], status: 'error' as const, error: String(userResult.reason) };
  const privilegeData =
    privilegeResult.status === 'fulfilled'
      ? privilegeResult.value
      : {
          summaries: [],
          status: 'error' as const,
          error: String(privilegeResult.reason),
        };
  const definers = definersResult.status === 'fulfilled' ? definersResult.value : [];

  const coverage: CoverageItem[] = [
    {
      check: 'User accounts',
      status: userData.status === 'ran' ? 'ran' : userData.status === 'denied' ? 'denied' : 'error',
      reason: userData.error,
      count: userData.users.length,
    },
    {
      check: 'Global privileges',
      status:
        privilegeData.status === 'ran'
          ? 'ran'
          : privilegeData.status === 'denied'
            ? 'denied'
            : 'error',
      reason: privilegeData.error,
      count: privilegeData.summaries.length,
    },
    {
      check: 'Object definers',
      status: definersResult.status === 'fulfilled' ? 'ran' : 'error',
      count: definers.length,
    },
    {
      check: 'Security variables',
      status: vars.local_infile !== undefined ? 'ran' : 'skipped',
      count: 5,
    },
  ];

  return {
    users: userData.users,
    privilegeSummaries: privilegeData.summaries,
    definers,
    config: configFromVariables(vars),
    coverage,
    generatedAt: new Date().toISOString(),
  };
}

export async function getGrants(profileId: string, user: string, host: string): Promise<GrantInfo> {
  const grantee = `'${user.replace(/'/g, "''")}'@'${host.replace(/'/g, "''")}'`;
  const grants: string[] = [];
  try {
    const result = await withConnection(profileId, async (conn) => {
      const [userRows] = await conn.query<Row[]>(
        `SELECT PRIVILEGE_TYPE, IS_GRANTABLE FROM information_schema.USER_PRIVILEGES WHERE GRANTEE = ?`,
        [grantee],
      );
      const [schemaRows] = await conn.query<Row[]>(
        `SELECT TABLE_SCHEMA, PRIVILEGE_TYPE, IS_GRANTABLE
         FROM information_schema.SCHEMA_PRIVILEGES WHERE GRANTEE = ?`,
        [grantee],
      );
      const [tableRows] = await conn.query<Row[]>(
        `SELECT TABLE_SCHEMA, TABLE_NAME, PRIVILEGE_TYPE, IS_GRANTABLE
         FROM information_schema.TABLE_PRIVILEGES WHERE GRANTEE = ?`,
        [grantee],
      );
      return { userRows, schemaRows, tableRows };
    });

    for (const row of result.userRows) {
      const withGrant = bool(row.IS_GRANTABLE) ? ' WITH GRANT OPTION' : '';
      grants.push(`GRANT ${str(row.PRIVILEGE_TYPE)} ON *.*${withGrant}`);
    }
    for (const row of result.schemaRows) {
      const withGrant = bool(row.IS_GRANTABLE) ? ' WITH GRANT OPTION' : '';
      grants.push(`GRANT ${str(row.PRIVILEGE_TYPE)} ON \`${str(row.TABLE_SCHEMA)}\`.*${withGrant}`);
    }
    for (const row of result.tableRows) {
      const withGrant = bool(row.IS_GRANTABLE) ? ' WITH GRANT OPTION' : '';
      grants.push(
        `GRANT ${str(row.PRIVILEGE_TYPE)} ON \`${str(row.TABLE_SCHEMA)}\`.\`${str(row.TABLE_NAME)}\`${withGrant}`,
      );
    }
    if (grants.length === 0) grants.push('GRANT USAGE ON *.*');
    return { user, host, grants };
  } catch (error) {
    throw new AppError('GRANTS_UNAVAILABLE', (error as Error).message, 403);
  }
}
