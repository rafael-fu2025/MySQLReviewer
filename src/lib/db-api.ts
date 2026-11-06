import type {
  AiReview,
  CharsetInfo,
  CreateDatabaseInput,
  CreateDatabaseResult,
  DatabaseObjects,
  ExplainResult,
  Finding,
  GrantSqlRequest,
  GrantSqlResult,
  HistoryEntry,
  PracticeAnswers,
  PracticeAttemptPublic,
  PracticeEvaluateRequest,
  PracticeEvaluation,
  PracticeProgressPublic,
  PracticeSetPublic,
  QueryResult,
  SavedReviewResult,
  Snippet,
  StaticReviewResult,
  TableDataRequest,
  TableDetail,
} from '@shared/types';
import { api, ApiError } from './api';

/** What a dump of one database contains. */
export interface DatabaseExportStats {
  tables: number;
  views: number;
  triggers: number;
  routines: number;
  rows: number;
  bytes: number;
}

/** The `.sql` script of one database, ready to be downloaded. */
export interface DatabaseExportResult {
  sql: string;
  filename: string;
  stats: DatabaseExportStats;
}

/** One statement of an imported script, with the gate it would have to pass. */
export interface ImportStatementPreview {
  sql: string;
  kind: string;
  needsUnlock: boolean;
  destructive: boolean;
  reason?: string;
  /**
   * True when the statement only changes session state - `SET` or `USE`. Such
   * a statement configures the session that loads a dump; the in-app import
   * runs every statement on its own, so it is skipped rather than run.
   */
  session?: boolean;
}

/** The statements a script holds. Nothing in it has been executed. */
export interface ImportPreviewResult {
  statements: ImportStatementPreview[];
  /** How many statements need the write unlock before they can run. */
  needsUnlockCount: number;
  /** How many statements change data or schema. */
  destructiveCount: number;
  /** True when the script carries a `DELIMITER` directive. */
  hasDelimiter: boolean;
  /** How many statements only change session state. */
  sessionCount?: number;
  /** The destructive statements, by their first line, for a warning. */
  destructiveStatements?: string[];
  bytes: number;
}

/** How a statement of an imported script ended. */
export type ImportRunStatus = 'pending' | 'running' | 'ok' | 'failed' | 'skipped';

/** The result of one statement of an imported script. */
export interface ImportRunOutcome {
  status: ImportRunStatus;
  error: string | null;
  code: string | null;
}

/**
 * One line of SQL, short enough to scan in a review list.
 *
 * The full statement stays in the preview; this is only the label the user
 * reads while reviewing the list.
 */
export function shortenSql(sql: string, maxLength = 140): string {
  const flat = sql.replace(/\s+/g, ' ').trim();
  if (flat.length <= maxLength) return flat;
  return `${flat.slice(0, Math.max(0, maxLength - 3))}...`;
}

/**
 * Run the reviewed statements one at a time.
 *
 * A dump often holds a few statements that legitimately fail, so the run
 * carries on after a failure and reports every outcome instead of stopping at
 * the first error. Each statement is awaited before the next one starts, so
 * the server sees them in the order the user reviewed.
 */
export async function runImportStatements(
  statements: ImportStatementPreview[],
  runOne: (statement: ImportStatementPreview, index: number) => Promise<void>,
  onOutcome?: (index: number, outcome: ImportRunOutcome) => void,
): Promise<ImportRunOutcome[]> {
  const outcomes: ImportRunOutcome[] = [];
  for (const [index, statement] of statements.entries()) {
    // A session statement (`SET`, `USE`) configures the session that loads a
    // dump. The in-app import runs every statement on its own, so such a
    // statement would either do nothing or be refused by the scope check. It is
    // reported as skipped rather than failed, so the run summary stays honest.
    if (statement.session) {
      outcomes.push({ status: 'skipped', error: null, code: null });
      onOutcome?.(outcomes.length - 1, outcomes[outcomes.length - 1]);
      continue;
    }
    try {
      await runOne(statement, index);
      outcomes.push({ status: 'ok', error: null, code: null });
    } catch (error) {
      outcomes.push({
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
        code: error instanceof ApiError ? error.code : null,
      });
    }
    onOutcome?.(outcomes.length - 1, outcomes[outcomes.length - 1]);
  }
  return outcomes;
}

/**
 * Thin browser-side client for the MyLens statement endpoints. The server is the
 * single execution boundary; this module never builds SQL by concatenation.
 */
export const dbApi = {
  run(
    profileId: string,
    statement: string,
    database: string | null,
    options: { revealSensitive?: boolean; cursorOffset?: number } = {},
  ): Promise<QueryResult> {
    const payload = {
      sql: statement,
      database,
      revealSensitive: options.revealSensitive === true,
      // Where the caret is in the submitted script. When the script holds
      // several statements, the one under the caret is the one that runs.
      ...(options.cursorOffset === undefined ? {} : { cursorOffset: options.cursorOffset }),
    };
    return api.post<QueryResult>(`/api/db/${encodeURIComponent(profileId)}/query`, payload);
  },

  explain(
    profileId: string,
    statement: string,
    database: string | null,
    analyze: boolean,
  ): Promise<ExplainResult> {
    const payload = { sql: statement, database, analyze };
    return api.post<ExplainResult>(`/api/db/${encodeURIComponent(profileId)}/explain`, payload);
  },

  review(
    profileId: string,
    statement: string,
    database: string | null,
    includeExplain: boolean,
    includeSchema = true,
  ): Promise<StaticReviewResult> {
    const payload = {
      profileId,
      database,
      sql: statement,
      includeSchema,
      includeExplain,
    };
    return api.post<StaticReviewResult>('/api/review/static', payload);
  },

  saveReview(payload: {
    profileId: string | null;
    database: string | null;
    statement: string;
    includeExplain: boolean;
    ai: AiReview | null;
  }): Promise<SavedReviewResult> {
    return api.post('/api/review/save', {
      profileId: payload.profileId,
      database: payload.database,
      sql: payload.statement,
      includeExplain: payload.includeExplain,
      ai: payload.ai,
    });
  },

  aiReviewBody(payload: {
    profileId: string;
    database: string | null;
    statement: string;
    providerId: string;
    model: string;
    includeSchema: boolean;
    includeExplain: boolean;
    analyze: boolean;
    findings?: Finding[];
    explain?: ExplainResult | null;
  }): Record<string, unknown> {
    return {
      profileId: payload.profileId,
      database: payload.database,
      sql: payload.statement,
      providerId: payload.providerId,
      model: payload.model,
      includeSchema: payload.includeSchema,
      includeExplain: payload.includeExplain,
      analyze: payload.analyze,
      findings: payload.findings,
      explain: payload.explain,
    };
  },

  history(profileId: string, limit = 150): Promise<HistoryEntry[]> {
    return api.get<HistoryEntry[]>(
      `/api/history?profileId=${encodeURIComponent(profileId)}&limit=${limit}`,
    );
  },

  clearHistory(profileId: string): Promise<unknown> {
    return api.del(`/api/history?profileId=${encodeURIComponent(profileId)}`);
  },

  snippets(): Promise<Snippet[]> {
    return api.get<Snippet[]>('/api/snippets');
  },

  saveSnippet(title: string, statement: string, tags: string[]): Promise<Snippet> {
    return api.post<Snippet>('/api/snippets', { title, sql: statement, tags });
  },

  deleteSnippet(id: string): Promise<unknown> {
    return api.del(`/api/snippets/${encodeURIComponent(id)}`);
  },

  objects(profileId: string, database: string): Promise<DatabaseObjects> {
    return api.get<DatabaseObjects>(
      `/api/db/${encodeURIComponent(profileId)}/databases/${encodeURIComponent(database)}/objects`,
    );
  },

  tableDetail(profileId: string, database: string, table: string): Promise<TableDetail> {
    return api.get<TableDetail>(
      `/api/db/${encodeURIComponent(profileId)}/databases/${encodeURIComponent(database)}/tables/${encodeURIComponent(table)}`,
    );
  },

  tableData(
    profileId: string,
    database: string,
    table: string,
    payload: TableDataRequest,
    options: { signal?: AbortSignal } = {},
  ): Promise<QueryResult> {
    return api.post<QueryResult>(
      `/api/db/${encodeURIComponent(profileId)}/databases/${encodeURIComponent(database)}/tables/${encodeURIComponent(table)}/data`,
      payload,
      options,
    );
  },

  objectInfo(
    profileId: string,
    database: string,
    type: 'view' | 'routine' | 'trigger' | 'event',
    name: string,
    routineType?: 'FUNCTION' | 'PROCEDURE',
  ): Promise<Record<string, unknown>> {
    const query = routineType ? `?routineType=${routineType}` : '';
    return api.get<Record<string, unknown>>(
      `/api/db/${encodeURIComponent(profileId)}/objects/${encodeURIComponent(database)}/${type}/${encodeURIComponent(name)}${query}`,
    );
  },

  listCharsets(profileId: string): Promise<CharsetInfo[]> {
    return api.get<CharsetInfo[]>(`/api/db/${encodeURIComponent(profileId)}/charsets`);
  },

  createDatabase(profileId: string, input: CreateDatabaseInput): Promise<CreateDatabaseResult> {
    return api.post<CreateDatabaseResult>(
      `/api/db/${encodeURIComponent(profileId)}/databases`,
      input,
    );
  },

  /**
   * Build a `.sql` dump of one database.
   *
   * The result is a script, not a data channel: it is downloaded as a file and
   * importing it later still goes through the ordinary gates. Exporting the
   * rows needs the write unlock, because a dump carries the raw value of every
   * column.
   */
  exportDatabase(
    profileId: string,
    database: string,
    options: { includeData?: boolean; includeObjects?: boolean; rowLimit?: number } = {},
  ): Promise<DatabaseExportResult> {
    const payload = {
      includeData: options.includeData === true,
      includeObjects: options.includeObjects !== false,
      ...(options.rowLimit === undefined ? {} : { rowLimit: options.rowLimit }),
    };
    return api.post<DatabaseExportResult>(
      `/api/db/${encodeURIComponent(profileId)}/databases/${encodeURIComponent(database)}/export`,
      payload,
    );
  },

  /**
   * Read a script and report the statements it holds.
   *
   * Nothing is executed here. The caller shows the statements and then runs
   * them one at a time through the ordinary query path.
   */
  previewImport(
    profileId: string,
    payload: { sql: string; database?: string | null },
  ): Promise<ImportPreviewResult> {
    return api.post<ImportPreviewResult>(
      `/api/db/${encodeURIComponent(profileId)}/import/preview`,
      { sql: payload.sql, database: payload.database ?? null },
    );
  },

  grantSql(profileId: string, input: GrantSqlRequest): Promise<GrantSqlResult> {
    return api.post<GrantSqlResult>(
      `/api/connections/${encodeURIComponent(profileId)}/grant-sql`,
      input,
    );
  },

  practiceSets(profileId: string, limit = 20): Promise<PracticeSetPublic[]> {
    return api.get<PracticeSetPublic[]>(
      `/api/practice/sets?profileId=${encodeURIComponent(profileId)}&limit=${limit}`,
    );
  },

  practiceAttempts(profileId: string, limit = 30): Promise<PracticeAttemptPublic[]> {
    return api.get<PracticeAttemptPublic[]>(
      `/api/practice/attempts?profileId=${encodeURIComponent(profileId)}&limit=${limit}`,
    );
  },

  practiceProgress(profileId: string): Promise<PracticeProgressPublic> {
    return api.get<PracticeProgressPublic>(
      `/api/practice/progress?profileId=${encodeURIComponent(profileId)}`,
    );
  },

  /**
   * Reference material is released only for questions this profile has already
   * attempted; the server filters the list, so the response never contains
   * answers for unattempted questions.
   */
  practiceAnswers(setId: string, profileId: string): Promise<PracticeAnswers> {
    return api.get<PracticeAnswers>(
      `/api/practice/sets/${encodeURIComponent(setId)}/answers?profileId=${encodeURIComponent(profileId)}`,
    );
  },

  /**
   * The graded answers of one set, so the answered state survives a reload.
   * Only the owning profile can read them.
   */
  practiceSetAttempts(setId: string, profileId: string): Promise<PracticeAttemptPublic[]> {
    return api.get<PracticeAttemptPublic[]>(
      `/api/practice/sets/${encodeURIComponent(setId)}/attempts?profileId=${encodeURIComponent(profileId)}`,
    );
  },

  practiceEvaluate(payload: PracticeEvaluateRequest): Promise<PracticeEvaluation> {
    return api.post<PracticeEvaluation>('/api/practice/evaluate', payload);
  },

  clearPracticeAttempts(profileId: string): Promise<unknown> {
    return api.del(`/api/practice/attempts?profileId=${encodeURIComponent(profileId)}`);
  },
};
