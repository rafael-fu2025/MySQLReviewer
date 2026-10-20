import type { FieldPacket, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { QueryColumn, QueryResult, QueryWarning } from '../../shared/types';
import { AppError, mapDbError } from '../errors';
import { addHistory } from '../store/history';
import { getSettings } from '../store/settings';
import { classifySql } from '../review/sql-classifier';
import { applyQueryGuards } from './dialect';
import {
  connectProfile,
  getCachedServerInfo,
  isWritesUnlocked,
  withConnection,
} from './manager';
import { estimateBytes, mysqlTypeName as typeName, serializeCell } from './serialize';
import { maskResultRows } from './masking';
import { assertSqlScope } from './scope';

interface Row extends RowDataPacket {
  [key: string]: unknown;
}

export interface ExecuteOptions {
  /** Overrides the selected database for this statement. */
  database?: string | null;
  /** Skip writing a history entry (used by internal previews). */
  skipHistory?: boolean;
  /** Explicitly reveal credential-like columns for this statement. */
  revealSensitive?: boolean;
  /** Override the configured result cap for this statement (max 10,000). */
  rowLimit?: number;
  /** Override the configured statement timeout in milliseconds. */
  timeoutMs?: number;
}

const MAX_SQL_LENGTH = 1_000_000;

export async function executeQuery(
  profileId: string,
  rawSql: string,
  options: ExecuteOptions = {},
): Promise<QueryResult> {
  const sql = rawSql.trim();
  if (!sql) throw new AppError('EMPTY_SQL', 'There is no SQL to execute.', 400);
  if (sql.length > MAX_SQL_LENGTH) {
    throw new AppError('SQL_TOO_LONG', 'The statement is too large to execute.', 400);
  }

  const classified = classifySql(sql);
  if (classified.empty) {
    throw new AppError('EMPTY_SQL', 'There is no SQL to execute.', 400);
  }
  if (classified.multiStatement) {
    throw new AppError(
      'MULTI_STATEMENT',
      'Run one statement at a time. Select the statement you want to execute.',
      400,
      { classification: classified.overall },
    );
  }
  const classification = classified.overall;
  await assertSqlScope(profileId, sql, options.database ?? null);
  const unlocked = isWritesUnlocked(profileId);
  if (classification.needsUnlock && !unlocked) {
    throw new AppError(
      'WRITE_LOCKED',
      classification.reason
        ? `Writes are locked. ${classification.reason}`
        : 'Writes are locked for this connection.',
      403,
      { classification },
    );
  }

  const settings = await getSettings();
  const database = options.database ?? null;
  const rowLimit = Math.max(1, Math.min(options.rowLimit ?? settings.rowLimit, 10_000));
  const timeoutMs = Math.max(
    500,
    Math.min(options.timeoutMs ?? settings.queryTimeoutMs, 300_000),
  );
  const started = performance.now();
  let server = getCachedServerInfo(profileId);
  if (!server) server = await connectProfile(profileId);

  try {
    const result = await withConnection(profileId, async (conn) => {
      if (database) {
        await conn.query('USE ??', [database]);
      }
      const guards = await applyQueryGuards(conn, server!, {
        ...settings,
        rowLimit,
        queryTimeoutMs: timeoutMs,
      });
      try {
        // Intentional SQL execution boundary. The statement is classified above,
        // multi-statements are rejected, and the pool disables multipleStatements.
        const [rawResult, fields] = await conn.query({
          sql,
          timeout: timeoutMs,
          rowsAsArray: true,
        });
        const elapsed = performance.now() - started;
        const resultIsRows = Array.isArray(rawResult);
        const rows = resultIsRows ? (rawResult as unknown[][]) : [];
        const header = resultIsRows ? null : (rawResult as ResultSetHeader);

        const warnings: QueryWarning[] = [];
        const warningStatus = Number(header?.warningStatus ?? 0);
        if (warningStatus > 0) {
          try {
            const [warnRows] = await conn.query<Row[]>('SHOW WARNINGS');
            for (const warn of warnRows) {
              warnings.push({
                level: String(warn.Level ?? 'Warning'),
                code: Number(warn.Code ?? 0),
                message: String(warn.Message ?? ''),
              });
            }
          } catch {
            // Warning details are best-effort.
          }
        }

        const columns: QueryColumn[] = (fields ?? []).map((field: FieldPacket) => {
          const extended = field as FieldPacket & {
            orgName?: string;
            database?: string;
            table?: string;
          };
          return {
            name: String(field.name ?? ''),
            originalName: String(extended.orgName ?? field.name ?? ''),
            table: extended.table ? String(extended.table) : null,
            database: extended.database ? String(extended.database) : null,
            typeName: typeName(Number(field.type ?? 0)),
            typeCode: Number(field.type ?? 0),
            flags: Number(field.flags ?? 0),
          };
        });

        const serializedRows = rows.map((row) =>
          row.map((cell) => serializeCell(cell, settings.cellMaxChars)),
        );
        const masked = maskResultRows(columns, serializedRows, {
          enabled: settings.maskSensitiveColumns,
          reveal: options.revealSensitive === true,
        });

        return {
          result: {
            sql,
            database,
            kind: classification.kind,
            columns: masked.columns,
            rows: masked.rows,
            rowCount: masked.rows.length,
            truncated: resultIsRows && masked.rows.length >= rowLimit,
            affectedRows: Number(header?.affectedRows ?? 0),
            insertId: header?.insertId != null ? String(header.insertId) : null,
            info: String(header?.info ?? ''),
            warnings,
            executionMs: Math.round(elapsed),
            bytesApprox: estimateBytes(masked.rows),
            unlocked,
            masked: masked.masked,
          } satisfies QueryResult,
          elapsed,
        };
      } finally {
        await guards.cleanup();
      }
    });

    if (!options.skipHistory) {
      await addHistory({
        profileId,
        database,
        sql,
        kind: classification.kind,
        success: true,
        executionMs: result.elapsed,
        rowCount: result.result.rowCount,
        error: null,
      }).catch(() => undefined);
    }
    return result.result;
  } catch (error) {
    const mapped = mapDbError(error);
    if (!options.skipHistory && mapped.code !== 'WRITE_LOCKED') {
      await addHistory({
        profileId,
        database,
        sql,
        kind: classification.kind,
        success: false,
        executionMs: performance.now() - started,
        rowCount: null,
        error: mapped.message,
      }).catch(() => undefined);
    }
    throw mapped;
  }
}

/** Run an internal, trusted, read-only statement and return raw rows. */
export async function runInternalQuery<T = unknown[]>(
  profileId: string,
  sql: string,
  params: unknown[] = [],
): Promise<T> {
  return withConnection(profileId, async (conn) => {
    const [rows] = await conn.query(sql, params as never);
    return rows as T;
  });
}
