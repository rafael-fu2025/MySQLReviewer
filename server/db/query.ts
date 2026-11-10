import type { FieldPacket, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { QueryColumn, QueryResult, QueryWarning } from '../../shared/types';
import { AppError, mapDbError } from '../errors';
import { addHistory } from '../store/history';
import { getStoredProfile } from '../store/profiles';
import { getSettings } from '../store/settings';
import { resolveWriteUnlock } from '../store/users';
import { classifySql, type StatementInfo } from '../review/sql-classifier';
import { tokenize, hasDelimiterDirective, type Token } from '../review/tokenizer';
import {
  applyQueryGuards,
  resolveStatementTimeoutMode,
  startStatementWatchdog,
  WATCHDOG_KILL_GRACE_MS,
  type StatementWatchdog,
} from './dialect';
import { connectProfile, getCachedServerInfo, getPool, withConnection } from './manager';
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
  /**
   * Internal: return the rows unmasked so a server-side grader can compare the
   * real values (an aliased credential column must not flip the verdict). The
   * column sensitivity marking still travels on `columns`, and the caller owns
   * masking every payload it persists or sends to a client.
   */
  skipMasking?: boolean;
  /** Override the configured result cap for this statement (max 10,000). */
  rowLimit?: number;
  /** Override the configured statement timeout in milliseconds. */
  timeoutMs?: number;
  /** Narrows a member session to their sandbox databases. */
  scopeOverride?: { allowed: string[] };
  /** Owning user for the history entry and for the write-unlock check. */
  userId?: string;
  /**
   * The caret position in the submitted script, as an offset into that exact
   * string.
   *
   * A script may hold several statements. Only one of them may be sent to the
   * server in a single command, so when the caller says where the caret is,
   * the statement under the caret is the one that runs.
   */
  cursorOffset?: number;
}

const MAX_SQL_LENGTH = 1_000_000;

/**
 * Strip literal values from a statement before it is written to the history
 * file: `INSERT INTO users (password) VALUES ('…')` must not leave the secret
 * on disk in cleartext.
 *
 * The slow-log normaliser in `server/db/metrics.ts` redacts literals with
 * regular expressions. This uses the SQL tokenizer instead, so escaped quotes
 * (`'it\'s'`) and quoted identifiers are handled correctly.
 */
export function redactStatementLiterals(sql: string): string {
  let tokens: Token[];
  try {
    tokens = tokenize(sql);
  } catch {
    return sql;
  }
  let out = sql;
  // Replace back to front so the offsets of the earlier literals stay valid.
  const literals = tokens.filter(
    (token) => token.kind === 'string' || token.kind === 'number' || token.kind === 'comment',
  );
  for (let index = literals.length - 1; index >= 0; index -= 1) {
    const token = literals[index];
    const replacement = token.kind === 'comment' ? ' ' : '?';
    out = out.slice(0, token.start) + replacement + out.slice(token.end);
  }
  return out;
}

/**
 * Whether the script looks like a stored routine whose body was cut apart.
 *
 * A compound block opens with `BEGIN` and closes with `END`, and both appear
 * as plain words in a routine definition. A `CASE ... END` expression has no
 * `BEGIN`, and a bare `BEGIN` (a transaction) has no `END`, so neither is
 * mistaken for a routine.
 */
function looksLikeRoutineBody(sql: string): boolean {
  let tokens: Token[];
  try {
    tokens = tokenize(sql);
  } catch {
    return false;
  }
  let hasBegin = false;
  let hasEnd = false;
  let mentionsRoutine = false;
  for (const token of tokens) {
    if (token.kind !== 'word' || token.quoted) continue;
    const upper = token.value.toUpperCase();
    if (upper === 'BEGIN') hasBegin = true;
    if (upper === 'END') hasEnd = true;
    if (upper === 'PROCEDURE' || upper === 'FUNCTION' || upper === 'TRIGGER' || upper === 'EVENT') {
      mentionsRoutine = true;
    }
  }
  return hasBegin && hasEnd && mentionsRoutine;
}

/**
 * The statement the caret is in.
 *
 * The caret may sit on the terminator or in the whitespace between two
 * statements; the statement before it is then the one the user means.
 */
export function statementAtOffset(
  statements: StatementInfo[],
  offset: number | undefined,
): StatementInfo | null {
  if (offset === undefined || offset < 0) return null;
  for (const statement of statements) {
    if (offset >= statement.start && offset < statement.end) return statement;
  }
  let candidate: StatementInfo | null = null;
  for (const statement of statements) {
    if (statement.start <= offset) candidate = statement;
  }
  return candidate;
}

/**
 * The rows and columns a statement produced.
 */
interface StatementResult {
  rows: unknown[][];
  columns: QueryColumn[];
  header: ResultSetHeader | null;
}

/** Turn a field list into the column descriptions the client renders. */
function toColumns(fields: FieldPacket[]): QueryColumn[] {
  return fields.map((field) => {
    const extended = field as FieldPacket & {
      orgName?: string;
      database?: string;
      table?: string;
    };
    return {
      name: String(field?.name ?? ''),
      originalName: String(extended?.orgName ?? field?.name ?? ''),
      table: extended?.table ? String(extended.table) : null,
      database: extended?.database ? String(extended.database) : null,
      typeName: typeName(Number(field?.type ?? 0), Number(field?.flags ?? 0)),
      typeCode: Number(field?.type ?? 0),
      flags: Number(field?.flags ?? 0),
    };
  });
}

/**
 * Normalise what mysql2 returned.
 *
 * A plain statement answers either with a list of rows plus a flat list of
 * fields, or with a result header. A stored procedure is different: the CALL
 * itself answers with an OK packet and the procedure's result set follows it, so
 * mysql2 hands back a **list of results** - `raw` is `[rows, header, ...]`
 * and `fields` is `[fieldsOfEachResult, ...]`, where the first entry is an
 * array rather than a field. Treating that as a plain result set made
 * `field.name` fail on an undefined field, so calling a procedure that returns
 * rows ended in "Cannot read properties of undefined".
 *
 * The first result that actually carries rows is the one the caller wants.
 */
export function normaliseStatementResult(raw: unknown, fields: unknown): StatementResult {
  const isMultiResult = Array.isArray(fields) && Array.isArray(fields[0]);
  if (isMultiResult) {
    const results = Array.isArray(raw) ? (raw as unknown[]) : [];
    const lists = fields as unknown[][];
    for (let index = 0; index < results.length; index += 1) {
      const rows = results[index];
      const list = lists[index];
      if (Array.isArray(rows) && Array.isArray(list)) {
        return {
          rows: rows as unknown[][],
          columns: toColumns(list as FieldPacket[]),
          header: null,
        };
      }
    }
    // The procedure produced no result set; report its OK packet.
    const last = results[results.length - 1];
    return {
      rows: [],
      columns: [],
      header: last && !Array.isArray(last) ? (last as ResultSetHeader) : null,
    };
  }
  const resultIsRows = Array.isArray(raw);
  return {
    rows: resultIsRows ? (raw as unknown[][]) : [],
    columns: toColumns((fields ?? []) as FieldPacket[]),
    header: resultIsRows ? null : (raw as ResultSetHeader),
  };
}

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
  // The caret position is relative to the exact text that was submitted, and
  // the script is trimmed below, so the offset moves with the leading space.
  const leading = rawSql.length - rawSql.trimStart().length;
  const cursorOffset =
    options.cursorOffset === undefined ? undefined : options.cursorOffset - leading;

  let statement: string;
  let classification = classified.overall;
  if (classified.multiStatement) {
    // A script may hold several statements. The one under the caret is the one
    // the user means, so that is the one that runs; without a caret there is
    // no way to tell, and the caller is asked for a single statement.
    const focused = statementAtOffset(classified.statements, cursorOffset);
    if (focused) {
      statement = focused.sql;
      // The statement that runs decides whether it needs the write unlock.
      classification = focused.classification;
    } else {
      // A stored routine is one statement whose body holds semicolons. Without
      // a `DELIMITER` directive the routine is cut apart at those semicolons and
      // the fragments are not valid SQL, so say what to do about it.
      if (!hasDelimiterDirective(sql) && looksLikeRoutineBody(sql)) {
        throw new AppError(
          'ROUTINE_NEEDS_DELIMITER',
          'A stored routine must be wrapped in a DELIMITER directive, so the semicolons inside its body do not end the statement: delimiter //  CREATE PROCEDURE p() BEGIN ... END//  delimiter ;',
          400,
        );
      }
      throw new AppError(
        'MULTI_STATEMENT',
        `This script holds ${classified.statements.length} statements. Run one at a time: put the cursor in the statement you want and use "Run statement".`,
        400,
        { classification: classified.overall, statementCount: classified.statements.length },
      );
    }
  } else {
    // A `DELIMITER` directive is a client-side instruction, not server SQL. The
    // text that reaches the server is the statement the splitter resolved, not
    // the raw script, so the directive is never sent and the routine it wrapped
    // arrives as one statement.
    statement = classified.statements[0]?.sql ?? sql;
  }
  // Pooled connections are reused, so an unqualified statement would otherwise
  // run against whichever database the previous request left selected.
  const profile = await getStoredProfile(profileId);
  const database = options.database ?? profile.database ?? null;
  await assertSqlScope(profileId, statement, database, options.scopeOverride);
  // The write lock belongs to one user: without a user id only the
  // profile-wide grant an administrator holds applies. The policy decides
  // whether this account may hold a grant at all.
  const writeAccess = await resolveWriteUnlock(profileId, options.userId);
  if (options.revealSensitive === true && !writeAccess.allowed) {
    // Revealing masked values is a write-level action, not a read convenience.
    throw new AppError(
      'REVEAL_LOCKED',
      writeAccess.blocker
        ? writeAccess.message
        : 'Unlock writes for this connection before revealing masked values.',
      403,
    );
  }
  if (classification.needsUnlock && !writeAccess.allowed) {
    throw new AppError(
      'WRITE_LOCKED',
      writeAccess.blocker
        ? writeAccess.message
        : classification.reason
          ? `Writes are locked. ${classification.reason}`
          : 'Writes are locked for this connection.',
      403,
      { classification },
    );
  }
  if (classification.needsUnlock && !database) {
    throw new AppError(
      'DATABASE_REQUIRED',
      'This statement can change data, so it needs a database. Select one for the statement or set a default database on the connection.',
      400,
      { classification },
    );
  }

  const settings = await getSettings();
  const rowLimit = Math.max(1, Math.min(options.rowLimit ?? settings.rowLimit, 10_000));
  const timeoutMs = Math.max(500, Math.min(options.timeoutMs ?? settings.queryTimeoutMs, 300_000));
  const started = performance.now();
  let server = getCachedServerInfo(profileId);
  if (!server) server = await connectProfile(profileId);
  // MariaDB bounds every statement with `max_statement_time`; MySQL only
  // bounds read-only SELECTs, so anything else needs the watchdog.
  const timeoutMode = resolveStatementTimeoutMode(server.flavor, classification.kind === 'read');
  const clientTimeoutMs =
    timeoutMode === 'watchdog' ? timeoutMs + WATCHDOG_KILL_GRACE_MS : timeoutMs;
  // The history file is a plain JSON file on disk: it must not keep secret
  // literals in cleartext.
  const historySql = redactStatementLiterals(statement);

  try {
    const result = await withConnection(
      profileId,
      async (conn) => {
        if (database) {
          await conn.query('USE ??', [database]);
        }
        const guards = await applyQueryGuards(
          conn,
          server!,
          {
            ...settings,
            // One row above the requested limit: the extra row is the only
            // reliable proof that the result was truncated.
            rowLimit: rowLimit + 1,
            queryTimeoutMs: timeoutMs,
          },
          { isReadOnly: classification.kind === 'read' },
        );
        let watchdog: StatementWatchdog | null = null;
        try {
          if (timeoutMode === 'watchdog') {
            watchdog = startStatementWatchdog({
              pool: await getPool(profileId),
              threadId: conn.threadId,
              timeoutMs,
            });
          }
          // Intentional SQL execution boundary. The statement is classified above,
          // multi-statements are rejected, and the pool disables multipleStatements.
          const [rawResult, fields] = await conn.query({
            sql: statement,
            timeout: clientTimeoutMs,
            rowsAsArray: true,
          });
          const elapsed = performance.now() - started;
          // A stored procedure answers with several results; everything else
          // answers with one. Normalise before reading the rows.
          const { rows, columns, header } = normaliseStatementResult(rawResult, fields);
          const resultIsRows = rows.length > 0 || columns.length > 0;

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

          // The server-side cap allows one row more than requested, so an
          // exactly-sized result is not mislabelled as truncated.
          const truncated = resultIsRows && rows.length > rowLimit;
          const limitedRows = truncated ? rows.slice(0, rowLimit) : rows;
          const serializedRows = limitedRows.map((row) =>
            row.map((cell) => serializeCell(cell, settings.cellMaxChars)),
          );
          const masked = maskResultRows(columns, serializedRows, {
            enabled: settings.maskSensitiveColumns,
            reveal: options.revealSensitive === true,
            sql: statement,
          });
          // The grading path compares raw values and re-masks everything it
          // sends on; the masked row copy is dropped, but the column marking
          // stays so the grader knows which columns would have been masked.
          const finalRows = options.skipMasking ? serializedRows : masked.rows;

          return {
            result: {
              sql: statement,
              database,
              kind: classification.kind,
              columns: masked.columns,
              rows: finalRows,
              rowCount: finalRows.length,
              truncated,
              affectedRows: Number(header?.affectedRows ?? 0),
              insertId: header?.insertId != null ? String(header.insertId) : null,
              info: String(header?.info ?? ''),
              warnings,
              executionMs: Math.round(elapsed),
              bytesApprox: estimateBytes(finalRows),
              unlocked: writeAccess.allowed,
              masked: options.skipMasking ? false : masked.masked,
            } satisfies QueryResult,
            elapsed,
          };
        } finally {
          watchdog?.cancel();
          await guards.cleanup();
        }
      },
      // Statements that can open a transaction must not leak it back into the pool.
      { rollbackOnRelease: classification.needsUnlock },
    );

    if (!options.skipHistory) {
      await addHistory({
        profileId,
        database,
        sql: historySql,
        kind: classification.kind,
        success: true,
        executionMs: result.elapsed,
        rowCount: result.result.rowCount,
        error: null,
        ...(options.userId ? { userId: options.userId } : {}),
      }).catch(() => undefined);
    }
    return result.result;
  } catch (error) {
    const mapped = mapDbError(error);
    if (!options.skipHistory && mapped.code !== 'WRITE_LOCKED') {
      await addHistory({
        profileId,
        database,
        sql: historySql,
        kind: classification.kind,
        success: false,
        executionMs: performance.now() - started,
        rowCount: null,
        error: mapped.message,
        ...(options.userId ? { userId: options.userId } : {}),
      }).catch(() => undefined);
    }
    throw mapped;
  }
}
