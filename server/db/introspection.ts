import type { FieldPacket, RowDataPacket } from 'mysql2/promise';
import type {
  ColumnInfo,
  DatabaseInfo,
  DatabaseObjects,
  EventInfo,
  ForeignKeyInfo,
  IndexInfo,
  PartitionInfo,
  QueryColumn,
  QueryResult,
  RoutineInfo,
  SchemaSnapshot,
  SchemaSummary,
  SchemaTable,
  TableDetail,
  TableDataRequest,
  TableSummary,
  TriggerInfo,
  ViewInfo,
} from '../../shared/types';
import { SYSTEM_SCHEMAS } from '../../shared/types';
import { AppError } from '../errors';
import { getSettings } from '../store/settings';
import { withConnection, getCachedServerInfo, connectProfile } from './manager';
import { applyQueryGuards } from './dialect';
import { estimateBytes, mysqlTypeName, serializeCell } from './serialize';
import { maskResultRows } from './masking';
import { filterDatabasesByScope, getDatabaseScope } from './scope';

interface Row extends RowDataPacket {
  [key: string]: unknown;
}

const schemaCache = new Map<string, { snapshot: SchemaSnapshot; expires: number }>();
const SCHEMA_TTL_MS = 30_000;

function num(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function str(value: unknown): string {
  return value == null ? '' : String(value);
}

function nullableStr(value: unknown): string | null {
  return value == null ? null : String(value);
}

function dateStr(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  return String(value);
}

export function invalidateSchemaCache(profileId?: string, database?: string): void {
  if (!profileId) {
    schemaCache.clear();
    return;
  }
  if (database) {
    schemaCache.delete(`${profileId}:${database}`);
    return;
  }
  for (const key of schemaCache.keys()) {
    if (key.startsWith(`${profileId}:`)) schemaCache.delete(key);
  }
}

export async function listDatabases(profileId: string): Promise<DatabaseInfo[]> {
  const rows = await withConnection(profileId, async (conn) => {
    const [result] = await conn.query<Row[]>(
      `SELECT
         s.SCHEMA_NAME AS name,
         s.DEFAULT_COLLATION_NAME AS collation,
         COALESCE(SUM(CASE WHEN t.TABLE_TYPE = 'BASE TABLE' THEN 1 ELSE 0 END), 0) AS table_count,
         COALESCE(SUM(CASE WHEN t.TABLE_TYPE = 'VIEW' THEN 1 ELSE 0 END), 0) AS view_count,
         COALESCE(SUM(COALESCE(t.DATA_LENGTH, 0) + COALESCE(t.INDEX_LENGTH, 0)), 0) AS size_bytes
       FROM information_schema.SCHEMATA s
       LEFT JOIN information_schema.TABLES t ON t.TABLE_SCHEMA = s.SCHEMA_NAME
       GROUP BY s.SCHEMA_NAME, s.DEFAULT_COLLATION_NAME
       ORDER BY s.SCHEMA_NAME`,
    );
    return result;
  });

  return filterDatabasesByScope(
    rows.map((row) => {
      const name = str(row.name);
      return {
        name,
        isSystem: SYSTEM_SCHEMAS.includes(name) || name.startsWith('_aria'),
        tableCount: num(row.table_count),
        viewCount: num(row.view_count),
        sizeBytes: num(row.size_bytes),
        collation: nullableStr(row.collation),
      };
    }),
    await getDatabaseScope(profileId),
  );
}

function mapTableSummary(row: Row): TableSummary {
  const type = str(row.TABLE_TYPE);
  return {
    database: str(row.TABLE_SCHEMA),
    name: str(row.TABLE_NAME),
    type: type === 'VIEW' ? 'VIEW' : type === 'SYSTEM VIEW' ? 'SYSTEM VIEW' : 'BASE TABLE',
    engine: nullableStr(row.ENGINE),
    rowsEstimate: num(row.TABLE_ROWS),
    dataBytes: num(row.DATA_LENGTH),
    indexBytes: num(row.INDEX_LENGTH),
    dataFreeBytes: num(row.DATA_FREE),
    collation: nullableStr(row.TABLE_COLLATION),
    comment: str(row.TABLE_COMMENT),
    createdAt: dateStr(row.CREATE_TIME),
    updatedAt: dateStr(row.UPDATE_TIME),
  };
}

export async function listTables(profileId: string, database: string): Promise<TableSummary[]> {
  const rows = await withConnection(profileId, async (conn) => {
    const [result] = await conn.query<Row[]>(
      `SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE, ENGINE, TABLE_ROWS, DATA_LENGTH,
              INDEX_LENGTH, DATA_FREE, TABLE_COLLATION, TABLE_COMMENT, CREATE_TIME, UPDATE_TIME
       FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = ?
       ORDER BY TABLE_TYPE, TABLE_NAME`,
      [database],
    );
    return result;
  });
  return rows.map(mapTableSummary);
}

export async function getTableSummary(
  profileId: string,
  database: string,
  table: string,
): Promise<TableSummary> {
  const rows = await withConnection(profileId, async (conn) => {
    const [result] = await conn.query<Row[]>(
      `SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE, ENGINE, TABLE_ROWS, DATA_LENGTH,
              INDEX_LENGTH, DATA_FREE, TABLE_COLLATION, TABLE_COMMENT, CREATE_TIME, UPDATE_TIME
       FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
      [database, table],
    );
    return result;
  });
  if (rows.length === 0) {
    throw new AppError('TABLE_NOT_FOUND', `Table ${database}.${table} was not found.`, 404);
  }
  return mapTableSummary(rows[0]);
}

function mapColumns(rows: Row[]): ColumnInfo[] {
  return rows.map((row) => ({
    name: str(row.COLUMN_NAME),
    position: num(row.ORDINAL_POSITION),
    dataType: str(row.DATA_TYPE).toLowerCase(),
    columnType: str(row.COLUMN_TYPE),
    nullable: str(row.IS_NULLABLE).toUpperCase() === 'YES',
    defaultValue: nullableStr(row.COLUMN_DEFAULT),
    extra: str(row.EXTRA),
    key: str(row.COLUMN_KEY),
    comment: str(row.COLUMN_COMMENT),
    charset: nullableStr(row.CHARACTER_SET_NAME),
    collation: nullableStr(row.COLLATION_NAME),
    generationExpression: nullableStr(row.GENERATION_EXPRESSION),
  }));
}

function mapIndexes(rows: Row[]): IndexInfo[] {
  const byName = new Map<string, IndexInfo>();
  for (const row of rows) {
    const name = str(row.INDEX_NAME);
    let index = byName.get(name);
    if (!index) {
      index = {
        name,
        unique: num(row.NON_UNIQUE) === 0,
        type: str(row.INDEX_TYPE) || 'BTREE',
        columns: [],
        cardinality: row.CARDINALITY == null ? null : num(row.CARDINALITY),
        comment: str(row.INDEX_COMMENT ?? row.COMMENT),
        redundantOf: null,
        duplicateOf: null,
      };
      byName.set(name, index);
    }
    index.columns.push({
      name: row.COLUMN_NAME == null ? '(expression)' : str(row.COLUMN_NAME),
      subPart: row.SUB_PART == null ? null : num(row.SUB_PART),
      collation: nullableStr(row.COLLATION),
    });
  }
  const indexes = Array.from(byName.values());

  const signatures = new Map<string, string>();
  for (const index of indexes) {
    const signature = `${index.columns.map((column) => column.name.toLowerCase()).join('|')}:${index.unique ? 'u' : 'n'}`;
    const existing = signatures.get(signature);
    if (existing) {
      index.duplicateOf = existing;
    } else {
      signatures.set(signature, index.name);
    }
  }

  for (const index of indexes) {
    if (index.unique || index.name === 'PRIMARY') continue;
    if (index.type === 'FULLTEXT' || index.type === 'SPATIAL') continue;
    const columns = index.columns.map((column) => column.name.toLowerCase());
    let best: IndexInfo | null = null;
    for (const candidate of indexes) {
      if (candidate.name === index.name) continue;
      if (candidate.type === 'FULLTEXT' || candidate.type === 'SPATIAL') continue;
      if (candidate.columns.length <= columns.length) continue;
      const prefix = candidate.columns
        .slice(0, columns.length)
        .map((column) => column.name.toLowerCase());
      if (prefix.every((name, i) => name === columns[i])) {
        if (!best || candidate.columns.length > best.columns.length) best = candidate;
      }
    }
    if (best) index.redundantOf = best.name;
  }

  return indexes.sort((a, b) => {
    if (a.name === 'PRIMARY') return -1;
    if (b.name === 'PRIMARY') return 1;
    return a.name.localeCompare(b.name);
  });
}

function mapForeignKeys(rows: Row[], referencedBy = false): ForeignKeyInfo[] {
  const byName = new Map<string, ForeignKeyInfo>();
  for (const row of rows) {
    const name = str(row.CONSTRAINT_NAME);
    let fk = byName.get(name);
    if (!fk) {
      fk = {
        name,
        columns: [],
        referencedDatabase: str(referencedBy ? row.TABLE_SCHEMA : row.REFERENCED_TABLE_SCHEMA),
        referencedTable: str(referencedBy ? row.TABLE_NAME : row.REFERENCED_TABLE_NAME),
        referencedColumns: [],
        onUpdate: str(row.UPDATE_RULE) || 'RESTRICT',
        onDelete: str(row.DELETE_RULE) || 'RESTRICT',
      };
      byName.set(name, fk);
    }
    fk.columns.push(str(referencedBy ? row.REFERENCED_COLUMN_NAME : row.COLUMN_NAME));
    fk.referencedColumns.push(str(referencedBy ? row.COLUMN_NAME : row.REFERENCED_COLUMN_NAME));
  }
  return Array.from(byName.values());
}

function mapTriggers(rows: Row[]): TriggerInfo[] {
  return rows.map((row) => ({
    name: str(row.TRIGGER_NAME),
    timing: str(row.ACTION_TIMING),
    event: str(row.EVENT_MANIPULATION),
    table: str(row.EVENT_OBJECT_TABLE),
    statement: str(row.ACTION_STATEMENT),
    definer: str(row.DEFINER),
    created: dateStr(row.CREATED),
    sqlMode: str(row.SQL_MODE),
  }));
}

function mapRoutines(rows: Row[]): RoutineInfo[] {
  return rows.map((row) => ({
    name: str(row.ROUTINE_NAME),
    type: str(row.ROUTINE_TYPE).toUpperCase() === 'FUNCTION' ? 'FUNCTION' : 'PROCEDURE',
    definer: str(row.DEFINER),
    created: dateStr(row.CREATED),
    modified: dateStr(row.LAST_ALTERED),
    securityType: str(row.SECURITY_TYPE),
    comment: str(row.ROUTINE_COMMENT),
    returnType: nullableStr(row.DTD_IDENTIFIER),
    parameters: null,
    body: null,
  }));
}

function mapEvents(rows: Row[]): EventInfo[] {
  return rows.map((row) => ({
    name: str(row.EVENT_NAME),
    definer: str(row.DEFINER),
    status: str(row.STATUS),
    eventType: str(row.EVENT_TYPE),
    executeAt: dateStr(row.EXECUTE_AT),
    intervalValue: nullableStr(row.INTERVAL_VALUE),
    intervalField: nullableStr(row.INTERVAL_FIELD),
    starts: dateStr(row.STARTS),
    ends: dateStr(row.ENDS),
    onCompletion: str(row.ON_COMPLETION),
    comment: str(row.EVENT_COMMENT),
  }));
}

export async function getTableDetail(
  profileId: string,
  database: string,
  table: string,
): Promise<TableDetail> {
  return withConnection(profileId, async (conn) => {
    const [tableRows] = await conn.query<Row[]>(
      `SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE, ENGINE, TABLE_ROWS, DATA_LENGTH,
              INDEX_LENGTH, DATA_FREE, TABLE_COLLATION, TABLE_COMMENT, CREATE_TIME, UPDATE_TIME
       FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
      [database, table],
    );
    if (tableRows.length === 0) {
      throw new AppError('TABLE_NOT_FOUND', `Table ${database}.${table} was not found.`, 404);
    }
    const summary = mapTableSummary(tableRows[0]);

    const [columnRows] = await conn.query<Row[]>(
      `SELECT COLUMN_NAME, ORDINAL_POSITION, DATA_TYPE, COLUMN_TYPE, IS_NULLABLE,
              COLUMN_DEFAULT, EXTRA, COLUMN_KEY, COLUMN_COMMENT,
              CHARACTER_SET_NAME, COLLATION_NAME, GENERATION_EXPRESSION
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
       ORDER BY ORDINAL_POSITION`,
      [database, table],
    );

    const [indexRows] = await conn.query<Row[]>(
      `SELECT INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME, SUB_PART, COLLATION,
              CARDINALITY, INDEX_TYPE, COMMENT, INDEX_COMMENT
       FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
       ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
      [database, table],
    );

    const fkSql = `SELECT rc.CONSTRAINT_NAME, rc.UPDATE_RULE, rc.DELETE_RULE,
                          kcu.COLUMN_NAME, kcu.TABLE_SCHEMA, kcu.TABLE_NAME,
                          kcu.REFERENCED_TABLE_SCHEMA, kcu.REFERENCED_TABLE_NAME,
                          kcu.REFERENCED_COLUMN_NAME, kcu.ORDINAL_POSITION
                   FROM information_schema.REFERENTIAL_CONSTRAINTS rc
                   JOIN information_schema.KEY_COLUMN_USAGE kcu
                     ON kcu.CONSTRAINT_SCHEMA = rc.CONSTRAINT_SCHEMA
                    AND kcu.CONSTRAINT_NAME = rc.CONSTRAINT_NAME
                    AND kcu.TABLE_NAME = rc.TABLE_NAME
                   WHERE `;
    const [fkRows] = await conn.query<Row[]>(
      `${fkSql} rc.CONSTRAINT_SCHEMA = ? AND rc.TABLE_NAME = ?
       ORDER BY rc.CONSTRAINT_NAME, kcu.ORDINAL_POSITION`,
      [database, table],
    );
    const [referencedRows] = await conn.query<Row[]>(
      `${fkSql} kcu.REFERENCED_TABLE_SCHEMA = ? AND kcu.REFERENCED_TABLE_NAME = ?
       ORDER BY rc.CONSTRAINT_NAME, kcu.ORDINAL_POSITION`,
      [database, table],
    );

    const [triggerRows] = await conn.query<Row[]>(
      `SELECT TRIGGER_NAME, ACTION_TIMING, EVENT_MANIPULATION, EVENT_OBJECT_TABLE,
              ACTION_STATEMENT, DEFINER, CREATED, SQL_MODE
       FROM information_schema.TRIGGERS
       WHERE TRIGGER_SCHEMA = ? AND EVENT_OBJECT_TABLE = ?
       ORDER BY TRIGGER_NAME`,
      [database, table],
    );

    let checks: TableDetail['checks'];
    try {
      const [checkRows] = await conn.query<Row[]>(
        `SELECT tc.CONSTRAINT_NAME, cc.CHECK_CLAUSE
         FROM information_schema.TABLE_CONSTRAINTS tc
         JOIN information_schema.CHECK_CONSTRAINTS cc
           ON cc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA
          AND cc.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
         WHERE tc.CONSTRAINT_SCHEMA = ? AND tc.TABLE_NAME = ?
           AND tc.CONSTRAINT_TYPE = 'CHECK'`,
        [database, table],
      );
      checks = checkRows.map((row) => ({
        name: str(row.CONSTRAINT_NAME),
        clause: str(row.CHECK_CLAUSE),
      }));
    } catch {
      checks = [];
    }

    let partitions: PartitionInfo[];
    try {
      const [partitionRows] = await conn.query<Row[]>(
        `SELECT PARTITION_NAME, PARTITION_METHOD, PARTITION_EXPRESSION,
                PARTITION_DESCRIPTION, TABLE_ROWS, DATA_LENGTH, INDEX_LENGTH
         FROM information_schema.PARTITIONS
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND PARTITION_NAME IS NOT NULL
         ORDER BY PARTITION_ORDINAL_POSITION`,
        [database, table],
      );
      partitions = partitionRows.map((row) => ({
        name: str(row.PARTITION_NAME),
        method: str(row.PARTITION_METHOD),
        expression: nullableStr(row.PARTITION_EXPRESSION),
        description: nullableStr(row.PARTITION_DESCRIPTION),
        tableRows: num(row.TABLE_ROWS),
        dataBytes: num(row.DATA_LENGTH),
        indexBytes: num(row.INDEX_LENGTH),
      }));
    } catch {
      partitions = [];
    }

    let createSql: string | null = null;
    try {
      await conn.query('USE ??', [database]);
      const [ddlRows] = await conn.query<Row[]>(
        summary.type === 'VIEW' ? 'SHOW CREATE VIEW ??' : 'SHOW CREATE TABLE ??',
        [table],
      );
      if (ddlRows.length > 0) {
        const values = Object.values(ddlRows[0]);
        const candidate = values.find(
          (value) => typeof value === 'string' && /^(CREATE|--|ALTER)/i.test(value.trim()),
        );
        createSql = candidate ? String(candidate) : null;
      }
    } catch {
      createSql = null;
    }

    return {
      summary,
      columns: mapColumns(columnRows),
      indexes: mapIndexes(indexRows),
      foreignKeys: mapForeignKeys(fkRows),
      referencedBy: mapForeignKeys(referencedRows, true),
      triggers: mapTriggers(triggerRows),
      checks,
      partitions,
      createSql,
    };
  });
}

export async function getDatabaseObjects(
  profileId: string,
  database: string,
): Promise<DatabaseObjects> {
  return withConnection(profileId, async (conn) => {
    const [tableRows] = await conn.query<Row[]>(
      `SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE, ENGINE, TABLE_ROWS, DATA_LENGTH,
              INDEX_LENGTH, DATA_FREE, TABLE_COLLATION, TABLE_COMMENT, CREATE_TIME, UPDATE_TIME
       FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = ?
       ORDER BY TABLE_TYPE, TABLE_NAME`,
      [database],
    );
    const [viewRows] = await conn.query<Row[]>(
      `SELECT TABLE_NAME, DEFINER, SECURITY_TYPE, CHECK_OPTION, IS_UPDATABLE
       FROM information_schema.VIEWS
       WHERE TABLE_SCHEMA = ?
       ORDER BY TABLE_NAME`,
      [database],
    );
    const [routineRows] = await conn.query<Row[]>(
      `SELECT ROUTINE_NAME, ROUTINE_TYPE, DEFINER, CREATED, LAST_ALTERED,
              SECURITY_TYPE, ROUTINE_COMMENT, DTD_IDENTIFIER
       FROM information_schema.ROUTINES
       WHERE ROUTINE_SCHEMA = ?
       ORDER BY ROUTINE_TYPE, ROUTINE_NAME`,
      [database],
    );
    const [triggerRows] = await conn.query<Row[]>(
      `SELECT TRIGGER_NAME, ACTION_TIMING, EVENT_MANIPULATION, EVENT_OBJECT_TABLE,
              ACTION_STATEMENT, DEFINER, CREATED, SQL_MODE
       FROM information_schema.TRIGGERS
       WHERE TRIGGER_SCHEMA = ?
       ORDER BY EVENT_OBJECT_TABLE, ACTION_TIMING, EVENT_MANIPULATION, TRIGGER_NAME`,
      [database],
    );
    const [eventRows] = await conn.query<Row[]>(
      `SELECT EVENT_NAME, DEFINER, STATUS, EVENT_TYPE, EXECUTE_AT, INTERVAL_VALUE,
              INTERVAL_FIELD, STARTS, ENDS, ON_COMPLETION, EVENT_COMMENT
       FROM information_schema.EVENTS
       WHERE EVENT_SCHEMA = ?
       ORDER BY EVENT_NAME`,
      [database],
    );

    const summaries = tableRows.map(mapTableSummary);
    return {
      tables: summaries.filter((table) => table.type === 'BASE TABLE'),
      views: viewRows.map((row) => ({
        name: str(row.TABLE_NAME),
        definer: str(row.DEFINER),
        securityType: str(row.SECURITY_TYPE),
        checkOption: str(row.CHECK_OPTION),
        updatable: str(row.IS_UPDATABLE).toUpperCase() === 'YES',
        definition: '',
      })),
      routines: mapRoutines(routineRows),
      triggers: mapTriggers(triggerRows),
      events: mapEvents(eventRows),
    };
  });
}

export async function getViewDefinition(
  profileId: string,
  database: string,
  view: string,
): Promise<ViewInfo> {
  const rows = await withConnection(profileId, async (conn) => {
    const [result] = await conn.query<Row[]>(
      `SELECT TABLE_NAME, DEFINER, SECURITY_TYPE, CHECK_OPTION, IS_UPDATABLE, VIEW_DEFINITION
       FROM information_schema.VIEWS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
      [database, view],
    );
    return result;
  });
  if (rows.length === 0) throw new AppError('VIEW_NOT_FOUND', 'View not found.', 404);
  return {
    name: str(rows[0].TABLE_NAME),
    definer: str(rows[0].DEFINER),
    securityType: str(rows[0].SECURITY_TYPE),
    checkOption: str(rows[0].CHECK_OPTION),
    updatable: str(rows[0].IS_UPDATABLE).toUpperCase() === 'YES',
    definition: str(rows[0].VIEW_DEFINITION),
  };
}

export async function getRoutineDefinition(
  profileId: string,
  database: string,
  type: 'FUNCTION' | 'PROCEDURE',
  name: string,
): Promise<RoutineInfo> {
  return withConnection(profileId, async (conn) => {
    const [rows] = await conn.query<Row[]>(
      `SELECT ROUTINE_NAME, ROUTINE_TYPE, DEFINER, CREATED, LAST_ALTERED,
              SECURITY_TYPE, ROUTINE_COMMENT, DTD_IDENTIFIER, ROUTINE_DEFINITION
       FROM information_schema.ROUTINES
       WHERE ROUTINE_SCHEMA = ? AND ROUTINE_NAME = ? AND ROUTINE_TYPE = ?`,
      [database, name, type],
    );
    if (rows.length === 0) throw new AppError('ROUTINE_NOT_FOUND', 'Routine not found.', 404);
    let parameters: string;
    try {
      const [paramRows] = await conn.query<Row[]>(
        `SELECT PARAMETER_NAME, PARAMETER_MODE, DTD_IDENTIFIER, ORDINAL_POSITION
         FROM information_schema.PARAMETERS
         WHERE SPECIFIC_SCHEMA = ? AND SPECIFIC_NAME = ?
         ORDER BY ORDINAL_POSITION`,
        [database, name],
      );
      parameters = paramRows
        .map((row) => {
          if (!row.PARAMETER_NAME) return str(row.DTD_IDENTIFIER);
          return `${str(row.PARAMETER_MODE)} ${str(row.PARAMETER_NAME)} ${str(row.DTD_IDENTIFIER)}`.trim();
        })
        .join(', ');
    } catch {
      parameters = '';
    }
    const routine = mapRoutines(rows)[0];
    return {
      ...routine,
      parameters,
      body: str(rows[0].ROUTINE_DEFINITION),
    };
  });
}

export async function getTriggerDefinition(
  profileId: string,
  database: string,
  trigger: string,
): Promise<TriggerInfo> {
  const rows = await withConnection(profileId, async (conn) => {
    const [result] = await conn.query<Row[]>(
      `SELECT TRIGGER_NAME, ACTION_TIMING, EVENT_MANIPULATION, EVENT_OBJECT_TABLE,
              ACTION_STATEMENT, DEFINER, CREATED, SQL_MODE
       FROM information_schema.TRIGGERS
       WHERE TRIGGER_SCHEMA = ? AND TRIGGER_NAME = ?`,
      [database, trigger],
    );
    return result;
  });
  if (rows.length === 0) throw new AppError('TRIGGER_NOT_FOUND', 'Trigger not found.', 404);
  return mapTriggers(rows)[0];
}

export async function getEventDefinition(
  profileId: string,
  database: string,
  event: string,
): Promise<EventInfo> {
  const rows = await withConnection(profileId, async (conn) => {
    const [result] = await conn.query<Row[]>(
      `SELECT EVENT_NAME, DEFINER, STATUS, EVENT_TYPE, EXECUTE_AT, INTERVAL_VALUE,
              INTERVAL_FIELD, STARTS, ENDS, ON_COMPLETION, EVENT_COMMENT
       FROM information_schema.EVENTS
       WHERE EVENT_SCHEMA = ? AND EVENT_NAME = ?`,
      [database, event],
    );
    return result;
  });
  if (rows.length === 0) throw new AppError('EVENT_NOT_FOUND', 'Event not found.', 404);
  return mapEvents(rows)[0];
}

export async function getSchemaSummary(
  profileId: string,
  database: string,
): Promise<SchemaSummary> {
  return withConnection(profileId, async (conn) => {
    const [tableRows] = await conn.query<Row[]>(
      `SELECT TABLE_NAME, TABLE_TYPE
       FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = ?
       ORDER BY TABLE_NAME`,
      [database],
    );
    const [columnRows] = await conn.query<Row[]>(
      `SELECT TABLE_NAME, COLUMN_NAME
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = ?
       ORDER BY TABLE_NAME, ORDINAL_POSITION`,
      [database],
    );
    const columnsByTable = new Map<string, string[]>();
    for (const row of columnRows) {
      const table = str(row.TABLE_NAME);
      const list = columnsByTable.get(table) ?? [];
      list.push(str(row.COLUMN_NAME));
      columnsByTable.set(table, list);
    }
    return {
      database,
      tables: tableRows.map((row) => ({
        name: str(row.TABLE_NAME),
        columns: columnsByTable.get(str(row.TABLE_NAME)) ?? [],
      })),
      fetchedAt: new Date().toISOString(),
    };
  });
}

export async function getSchemaSnapshot(
  profileId: string,
  database: string,
  force = false,
): Promise<SchemaSnapshot> {
  const key = `${profileId}:${database}`;
  const cached = schemaCache.get(key);
  if (!force && cached && cached.expires > Date.now()) return cached.snapshot;

  const snapshot = await withConnection(profileId, async (conn) => {
    const [tableRows] = await conn.query<Row[]>(
      `SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE, ENGINE, TABLE_ROWS, DATA_LENGTH,
              INDEX_LENGTH, DATA_FREE, TABLE_COLLATION, TABLE_COMMENT
       FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'
       ORDER BY TABLE_NAME`,
      [database],
    );
    const [columnRows] = await conn.query<Row[]>(
      `SELECT TABLE_NAME, COLUMN_NAME, ORDINAL_POSITION, DATA_TYPE, COLUMN_TYPE,
              IS_NULLABLE, COLUMN_DEFAULT, EXTRA, COLUMN_KEY, COLUMN_COMMENT,
              CHARACTER_SET_NAME, COLLATION_NAME
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = ?
       ORDER BY TABLE_NAME, ORDINAL_POSITION`,
      [database],
    );
    const [indexRows] = await conn.query<Row[]>(
      `SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME, SUB_PART,
              COLLATION, CARDINALITY, INDEX_TYPE, COMMENT, INDEX_COMMENT
       FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = ?
       ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`,
      [database],
    );
    const [fkRows] = await conn.query<Row[]>(
      `SELECT rc.CONSTRAINT_NAME, rc.TABLE_NAME, rc.UPDATE_RULE, rc.DELETE_RULE,
              kcu.COLUMN_NAME, kcu.REFERENCED_TABLE_SCHEMA, kcu.REFERENCED_TABLE_NAME,
              kcu.REFERENCED_COLUMN_NAME, kcu.ORDINAL_POSITION
       FROM information_schema.REFERENTIAL_CONSTRAINTS rc
       JOIN information_schema.KEY_COLUMN_USAGE kcu
         ON kcu.CONSTRAINT_SCHEMA = rc.CONSTRAINT_SCHEMA
        AND kcu.CONSTRAINT_NAME = rc.CONSTRAINT_NAME
        AND kcu.TABLE_NAME = rc.TABLE_NAME
       WHERE rc.CONSTRAINT_SCHEMA = ?
       ORDER BY rc.TABLE_NAME, rc.CONSTRAINT_NAME, kcu.ORDINAL_POSITION`,
      [database],
    );

    const columnsByTable = new Map<string, Row[]>();
    for (const row of columnRows) {
      const table = str(row.TABLE_NAME);
      const list = columnsByTable.get(table) ?? [];
      list.push(row);
      columnsByTable.set(table, list);
    }
    const indexesByTable = new Map<string, Row[]>();
    for (const row of indexRows) {
      const table = str(row.TABLE_NAME);
      const list = indexesByTable.get(table) ?? [];
      list.push(row);
      indexesByTable.set(table, list);
    }
    const keysByTable = new Map<string, Row[]>();
    for (const row of fkRows) {
      const table = str(row.TABLE_NAME);
      const list = keysByTable.get(table) ?? [];
      list.push(row);
      keysByTable.set(table, list);
    }

    return {
      database,
      fetchedAt: new Date().toISOString(),
      tables: tableRows.map((row) => {
        const name = str(row.TABLE_NAME);
        const collation = nullableStr(row.TABLE_COLLATION);
        return {
          database,
          name,
          type: 'BASE TABLE',
          engine: nullableStr(row.ENGINE),
          rowsEstimate: num(row.TABLE_ROWS),
          dataBytes: num(row.DATA_LENGTH),
          indexBytes: num(row.INDEX_LENGTH),
          dataFreeBytes: num(row.DATA_FREE),
          collation,
          charset: collation ? collation.split('_')[0] : null,
          comment: str(row.TABLE_COMMENT),
          columns: mapColumns(columnsByTable.get(name) ?? []),
          indexes: mapIndexes(indexesByTable.get(name) ?? []),
          foreignKeys: mapForeignKeys(keysByTable.get(name) ?? []),
        } satisfies SchemaTable;
      }),
    } satisfies SchemaSnapshot;
  });

  schemaCache.set(key, { snapshot, expires: Date.now() + SCHEMA_TTL_MS });
  return snapshot;
}

export async function getTableData(
  profileId: string,
  database: string,
  table: string,
  request: TableDataRequest = {},
): Promise<QueryResult> {
  const settings = await getSettings();
  const limit = Math.max(1, Math.min(1000, Math.trunc(request.limit ?? 100)));
  const offset = Math.max(0, Math.trunc(request.offset ?? 0));
  const started = performance.now();

  return withConnection(profileId, async (conn) => {
    const [columnRows] = await conn.query<Row[]>(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
      [database, table],
    );
    if (columnRows.length === 0) {
      throw new AppError('TABLE_NOT_FOUND', `Table ${database}.${table} was not found.`, 404);
    }
    const validColumns = new Map<string, string>();
    for (const row of columnRows) {
      const name = str(row.COLUMN_NAME);
      validColumns.set(name.toLowerCase(), name);
    }

    const fragments: string[] = [];
    const filterParams: unknown[] = [];
    for (const filter of request.filters ?? []) {
      const column = validColumns.get(filter.column.toLowerCase());
      if (!column) continue;
      const operator = filter.operator;
      if (operator === 'IS NULL' || operator === 'IS NOT NULL') {
        fragments.push(`?? ${operator}`);
        filterParams.push(column);
        continue;
      }
      const supported = ['=', '!=', '>', '>=', '<', '<=', 'LIKE', 'NOT LIKE'];
      if (!supported.includes(operator)) continue;
      fragments.push(`?? ${operator} ?`);
      filterParams.push(column, filter.value ?? '');
    }

    let orderSql = '';
    let orderColumn: string | null = null;
    if (request.orderBy) {
      const column = validColumns.get(request.orderBy.toLowerCase());
      if (column) {
        const direction = request.orderDir === 'desc' ? 'DESC' : 'ASC';
        orderSql = ` ORDER BY ?? ${direction}`;
        orderColumn = column;
      }
    }

    await conn.query('USE ??', [database]);
    const statement = `SELECT * FROM ??${fragments.length ? ` WHERE ${fragments.join(' AND ')}` : ''}${orderSql} LIMIT ? OFFSET ?`;
    const params: unknown[] = [table, ...filterParams];
    if (orderColumn) params.push(orderColumn);
    params.push(limit, offset);

    const server = getCachedServerInfo(profileId) ?? (await connectProfile(profileId));
    const guards = await applyQueryGuards(conn, server, settings);
    try {
      const [rawRows, fields] = await conn.query({
        sql: statement,
        values: params,
        rowsAsArray: true,
        timeout: settings.queryTimeoutMs,
      });
      const now = performance.now();
      const dataRows = Array.isArray(rawRows) ? (rawRows as unknown[][]) : [];
      const serialized = dataRows.map((row) =>
        row.map((cell) => serializeCell(cell, settings.cellMaxChars)),
      );
      const columns: QueryColumn[] = (fields ?? []).map((field: FieldPacket) => {
        const extended = field as FieldPacket & {
          orgName?: string;
          database?: string;
        };
        return {
          name: str(extended.name),
          originalName: str(extended.orgName ?? extended.name),
          table: extended.table ? str(extended.table) : null,
          database: extended.database ? str(extended.database) : null,
          typeName: mysqlTypeName(Number(extended.type ?? 0)),
          typeCode: Number(extended.type ?? 0),
          flags: Number(extended.flags ?? 0),
        };
      });
      const masked = maskResultRows(columns, serialized, {
        enabled: settings.maskSensitiveColumns,
        reveal: request.revealSensitive === true,
      });
      return {
        sql: statement,
        database,
        kind: 'read',
        columns: masked.columns,
        rows: masked.rows,
        rowCount: masked.rows.length,
        truncated: masked.rows.length >= limit,
        affectedRows: 0,
        insertId: null,
        info: '',
        warnings: [],
        executionMs: Math.round(now - started),
        bytesApprox: estimateBytes(masked.rows),
        unlocked: false,
        masked: masked.masked,
      } satisfies QueryResult;
    } finally {
      await guards.cleanup();
    }
  });
}

export async function getTopTables(
  profileId: string,
  limit = 10,
): Promise<{ database: string; table: string; rowsEstimate: number; totalBytes: number }[]> {
  const rows = await withConnection(profileId, async (conn) => {
    const [result] = await conn.query<Row[]>(
      `SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_ROWS, DATA_LENGTH, INDEX_LENGTH
       FROM information_schema.TABLES
       WHERE TABLE_SCHEMA NOT IN ('mysql', 'information_schema', 'performance_schema', 'sys')
         AND TABLE_TYPE = 'BASE TABLE'
       ORDER BY (COALESCE(DATA_LENGTH, 0) + COALESCE(INDEX_LENGTH, 0)) DESC
       LIMIT ?`,
      [Math.max(1, Math.min(50, limit))],
    );
    return result;
  });
  const scope = await getDatabaseScope(profileId);
  return rows
    .map((row) => ({
      database: str(row.TABLE_SCHEMA),
      table: str(row.TABLE_NAME),
      rowsEstimate: num(row.TABLE_ROWS),
      totalBytes: num(row.DATA_LENGTH) + num(row.INDEX_LENGTH),
    }))
    .filter((table) => scope.mode === 'all' || scope.allowed.has(table.database));
}
