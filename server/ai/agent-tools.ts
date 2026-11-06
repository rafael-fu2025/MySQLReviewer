import {
  getDatabaseObjects,
  getEventDefinition,
  getRoutineDefinition,
  getSchemaSnapshot,
  getTableData,
  getTableDetail,
  getTriggerDefinition,
  getViewDefinition,
  listTables,
} from '../db/introspection';
import { assertDatabaseAllowed } from '../db/scope';
import { executeQuery } from '../db/query';
import {
  getGlobalStatus,
  getGlobalVariables,
  getPerformanceSnapshot,
  getProcessList,
  getSlowQueries,
} from '../db/metrics';
import { getCachedServerInfo, connectProfile } from '../db/manager';
import { runExplain } from '../db/explain';
import { runSecurityAudit } from '../db/security-audit';
import { classifySql } from '../review/sql-classifier';
import { buildRuleContext } from '../review/context';
import { suggestIndexes } from '../review/index-advisor';
import { runStaticReview } from '../review/static-review';
import { listHistory } from '../store/history';
import { createSnippet, listSnippets } from '../store/snippets';
import { getSettings } from '../store/settings';
import type { ChatToolDefinition } from './http';

/** Hard ceiling on one tool result fed back to the model. */
export const TOOL_RESULT_MAX_CHARS = 8_000;

/** A proposal card carries at most this much SQL. */
export const PROPOSAL_SQL_MAX_CHARS = 20_000;

export interface AgentToolContext {
  profileId: string;
  database: string;
  scopeOverride?: { allowed: string[] };
  userId?: string;
  /** Server-wide tools (slow log, security audit) need the connection to allow them. */
  serverWide: boolean;
  /** Members only ever see their own history and snippets. */
  userRole: 'admin' | 'member';
  /**
   * When set, structure tools only see these tables — the challenge tutor's
   * leash. Data tools are excluded entirely for the coach (see
   * {@link buildCoachTools}); this narrows what the remaining tools reveal.
   */
  tableFilter?: string[];
}

export type AgentToolHandler = (args: Record<string, unknown>) => Promise<string>;

export interface AgentToolSet {
  definitions: ChatToolDefinition[];
  handlers: Map<string, AgentToolHandler>;
}

/** The largest number of rows a tool query may return to the model. */
const TOOL_ROW_LIMIT = 50;

/** Variables worth showing the model when it asks about server state. */
const NOTABLE_STATUS =
  /(^|_)(version|uptime|threads_|questions|queries|slow_queries|aborted_|bytes_|created_tmp_|handler_|select_|sort_|innodb_row_|innodb_buffer_pool_|innodb_data_|key_|open_|qcache|table_open_cache|maximum_reached)/i;
const NOTABLE_VARIABLE =
  /(version|sql_mode|transaction_isolation|tx_isolation|innodb_buffer_pool_size|max_connections|long_query_time|slow_query_log|innodb_flush|tmp_table_size|max_heap_table_size|table_open_cache|join_buffer_size|sort_buffer_size)/i;

/** Truncates a tool output so one greedy tool cannot blow the prompt budget. */
export function truncateToolOutput(output: string): string {
  if (output.length <= TOOL_RESULT_MAX_CHARS) return output;
  return `${output.slice(0, TOOL_RESULT_MAX_CHARS)}\n…[truncated ${output.length - TOOL_RESULT_MAX_CHARS} chars]`;
}

/** Tool failures are answers the model can read, not exceptions. */
function toolError(message: string): string {
  return JSON.stringify({ error: message });
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function argString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === 'string' ? value : '';
}

function argNumber(args: Record<string, unknown>, key: string, fallback: number): number {
  const value = args[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * The tools the workspace agent may use, bound to one connection profile and
 * database. Every handler runs behind the same guards the interactive UI runs
 * behind: profile assignment was checked by the route, `assertDatabaseAllowed`
 * is re-checked here, and the query tools inherit the write lock, the row
 * limit, the statement timeout and result masking.
 *
 * The read-only tool refuses to run anything but read statements itself, with
 * a structured error the model can correct from — the same pattern SeaSID uses
 * for a missing site key.
 */
export function buildWorkspaceTools(ctx: AgentToolContext): AgentToolSet {
  const readOnlyGuard = (sql: string): string | null => {
    if (!sql.trim()) return 'The `sql` argument is empty.';
    const classified = classifySql(sql);
    if (classified.empty) return 'The `sql` argument holds no executable statement.';
    if (classified.multiStatement) {
      return 'Only one statement at a time. Remove the extra statements and retry.';
    }
    if (classified.overall.kind !== 'read') {
      return 'Only read statements (SELECT / SHOW / DESC / EXPLAIN) may run here. Rewrite the statement as a read and retry; the user runs writes themselves in the editor.';
    }
    return null;
  };

  const definitions: ChatToolDefinition[] = [
    {
      name: 'list_tables',
      description:
        'List the tables of the connected database with engine, estimated row count and size. Use this first when you need to discover the schema.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'describe_table',
      description:
        'Show the columns, indexes and table options of one table in the connected database.',
      parameters: {
        type: 'object',
        properties: {
          table: {
            type: 'string',
            description: 'The table name, exactly as listed by list_tables.',
          },
        },
        required: ['table'],
        additionalProperties: false,
      },
    },
    {
      name: 'explain_sql',
      description:
        'Run EXPLAIN on one SELECT statement against the connected database and return the plan. Set analyze to true to also execute the query (slower, runs the statement).',
      parameters: {
        type: 'object',
        properties: {
          sql: { type: 'string', description: 'A single SELECT statement.' },
          analyze: {
            type: 'boolean',
            description: 'Run EXPLAIN ANALYZE instead of a plain EXPLAIN.',
          },
        },
        required: ['sql'],
        additionalProperties: false,
      },
    },
    {
      name: 'run_readonly_query',
      description:
        'Execute one read-only SQL statement (SELECT, SHOW, DESC) against the connected database and return up to 50 rows. Writes, DDL and multiple statements are rejected. Use it to check real data before answering.',
      parameters: {
        type: 'object',
        properties: {
          sql: { type: 'string', description: 'A single read-only statement.' },
          max_rows: { type: 'integer', description: 'Row cap between 1 and 50 (default 20).' },
        },
        required: ['sql'],
        additionalProperties: false,
      },
    },
    {
      name: 'review_sql',
      description:
        'Run the deterministic SQL review (rules, scoring, index suggestions) on one statement without calling the AI review.',
      parameters: {
        type: 'object',
        properties: {
          sql: { type: 'string', description: 'The statement to review.' },
        },
        required: ['sql'],
        additionalProperties: false,
      },
    },
    {
      name: 'server_status',
      description:
        'Read notable server status counters and system variables (version, buffer pool, connections, temporary tables, sort behaviour, isolation).',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'process_list',
      description:
        'Show the current server process list (running queries, their state and duration).',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'perf_snapshot',
      description:
        'Take a performance snapshot of the connected server: status counters, process list and the largest tables.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'sample_table',
      description:
        'Preview up to 20 rows of one table (masked like every result). Use it to check real value distributions before answering.',
      parameters: {
        type: 'object',
        properties: {
          table: {
            type: 'string',
            description: 'The table name, exactly as listed by list_tables.',
          },
          limit: { type: 'integer', description: 'Row cap between 1 and 20 (default 10).' },
          order_by: { type: 'string', description: 'Column to order by (must exist).' },
        },
        required: ['table'],
        additionalProperties: false,
      },
    },
    {
      name: 'list_objects',
      description:
        'List the non-table objects of the database: views, stored routines, triggers and events, with a count of each kind.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'get_object_definition',
      description:
        'Read the full definition of one view, stored procedure, function, trigger or event.',
      parameters: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            enum: ['view', 'procedure', 'function', 'trigger', 'event'],
            description: 'The kind of object.',
          },
          name: {
            type: 'string',
            description: 'The object name, exactly as listed by list_objects.',
          },
        },
        required: ['type', 'name'],
        additionalProperties: false,
      },
    },
    {
      name: 'index_advisor',
      description:
        'Suggest indexes for one SQL statement from its predicates, ordering and the real schema. Returns ready ALTER TABLE statements with a confidence level.',
      parameters: {
        type: 'object',
        properties: {
          sql: { type: 'string', description: 'The statement to advise on.' },
        },
        required: ['sql'],
        additionalProperties: false,
      },
    },
    {
      name: 'search_history',
      description:
        'Search previously executed queries (literals redacted) for a text fragment, e.g. a table or column name. Members search only their own history.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Case-insensitive text to find in the SQL.' },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
    {
      name: 'find_snippet',
      description:
        'Search the saved SQL snippets by title, content or tag. Members search only their own snippets.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Case-insensitive text to find.' },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
    {
      name: 'save_snippet',
      description:
        'Save a SQL statement as a named snippet for the current user. Use it when the user asks to keep a statement for reuse.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short human name, up to 120 chars.' },
          sql: { type: 'string', description: 'The statement to save.' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags, max 10.' },
        },
        required: ['title', 'sql'],
        additionalProperties: false,
      },
    },
    {
      name: 'slow_queries',
      description:
        'Top slow statements of the server by digest, from Performance Schema or the slow query log, with count, average and worst latency.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'security_audit',
      description:
        'Run the security audit of the connected server: accounts, privileges, definers and security-relevant configuration, with rule findings.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'propose_sql',
      description:
        'Offer a finished SQL statement to the user as a clickable proposal card. The user — not you — decides whether to put it in the editor. Use it instead of pasting large statements into prose whenever the user is likely to run what you wrote.',
      parameters: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: 'Short human label, e.g. "Add customer_id index".',
          },
          sql: { type: 'string', description: 'The complete statement to propose.' },
          rationale: { type: 'string', description: 'One sentence on why this statement helps.' },
        },
        required: ['title', 'sql'],
        additionalProperties: false,
      },
    },
  ];

  const handlers = new Map<string, AgentToolHandler>();

  const tableLeash = ctx.tableFilter?.length
    ? new Set(ctx.tableFilter.map((name) => name.toLowerCase()))
    : null;

  handlers.set('list_tables', async () => {
    await assertDatabaseAllowed(ctx.profileId, ctx.database, ctx.scopeOverride);
    const tables = await listTables(ctx.profileId, ctx.database);
    const visible = tableLeash
      ? tables.filter((table) => tableLeash.has(table.name.toLowerCase()))
      : tables;
    const detailed = visible.slice(0, 200).map((table) => ({
      name: table.name,
      type: table.type,
      engine: table.engine,
      rowsEstimate: table.rowsEstimate,
      dataBytes: table.dataBytes,
      indexBytes: table.indexBytes,
      comment: table.comment || undefined,
    }));
    return json({ database: ctx.database, tableCount: visible.length, tables: detailed });
  });

  handlers.set('describe_table', async (args) => {
    const table = argString(args, 'table').trim();
    if (!table) return toolError('The `table` argument is required.');
    if (tableLeash && !tableLeash.has(table.toLowerCase())) {
      return toolError(
        `Only the tables of this challenge may be inspected: ${[...tableLeash].join(', ')}.`,
      );
    }
    await assertDatabaseAllowed(ctx.profileId, ctx.database, ctx.scopeOverride);
    const detail = await getTableDetail(ctx.profileId, ctx.database, table);
    return json({
      summary: {
        name: detail.summary.name,
        type: detail.summary.type,
        engine: detail.summary.engine,
        rowsEstimate: detail.summary.rowsEstimate,
        dataBytes: detail.summary.dataBytes,
        indexBytes: detail.summary.indexBytes,
        comment: detail.summary.comment || undefined,
      },
      columns: detail.columns.map((column) => ({
        name: column.name,
        type: column.columnType,
        nullable: column.nullable,
        key: column.key || undefined,
        default: column.defaultValue ?? undefined,
        extra: column.extra || undefined,
        comment: column.comment || undefined,
      })),
      indexes: detail.indexes,
      foreignKeys: detail.foreignKeys,
      createSql: detail.createSql ?? undefined,
    });
  });

  handlers.set('explain_sql', async (args) => {
    const sql = argString(args, 'sql');
    const guard = readOnlyGuard(sql);
    if (guard) return toolError(guard);
    const settings = await getSettings();
    const result = await runExplain(ctx.profileId, sql, ctx.database, {
      analyze: args.analyze === true,
      scopeOverride: ctx.scopeOverride,
      userId: ctx.userId,
    });
    return json({ ...result, settingsTimeoutMs: settings.queryTimeoutMs });
  });

  handlers.set('run_readonly_query', async (args) => {
    const sql = argString(args, 'sql');
    const guard = readOnlyGuard(sql);
    if (guard) return toolError(guard);
    const maxRows = Math.max(
      1,
      Math.min(Math.trunc(argNumber(args, 'max_rows', 20)), TOOL_ROW_LIMIT),
    );
    const result = await executeQuery(ctx.profileId, sql, {
      database: ctx.database,
      scopeOverride: ctx.scopeOverride,
      userId: ctx.userId,
      rowLimit: maxRows,
      timeoutMs: 15_000,
    });
    return json({
      columns: result.columns.map((column) => column.name),
      rows: result.rows,
      rowCount: result.rowCount,
      truncated: result.truncated,
      note: 'The statement was executed and recorded in the query history (literals redacted).',
    });
  });

  handlers.set('review_sql', async (args) => {
    const sql = argString(args, 'sql');
    if (!sql.trim()) return toolError('The `sql` argument is required.');
    const result = await runStaticReview({
      profileId: ctx.profileId,
      database: ctx.database,
      sql,
      includeExplain: false,
      scopeOverride: ctx.scopeOverride,
    });
    return json({
      score: result.score,
      statements: result.statements,
      findings: result.findings,
      suggestions: result.suggestions,
      warnings: result.warnings,
    });
  });

  handlers.set('server_status', async () => {
    await assertDatabaseAllowed(ctx.profileId, ctx.database, ctx.scopeOverride);
    const [status, variables] = await Promise.all([
      getGlobalStatus(ctx.profileId),
      getGlobalVariables(ctx.profileId),
    ]);
    const pick = (record: Record<string, string>, pattern: RegExp): Record<string, string> =>
      Object.fromEntries(Object.entries(record).filter(([key]) => pattern.test(key)));
    return json({
      status: pick(status, NOTABLE_STATUS),
      variables: pick(variables, NOTABLE_VARIABLE),
    });
  });

  handlers.set('process_list', async () => {
    await assertDatabaseAllowed(ctx.profileId, ctx.database, ctx.scopeOverride);
    const processes = await getProcessList(ctx.profileId);
    return json({ processes });
  });

  handlers.set('perf_snapshot', async () => {
    await assertDatabaseAllowed(ctx.profileId, ctx.database, ctx.scopeOverride);
    const snapshot = await getPerformanceSnapshot(ctx.profileId, ctx.scopeOverride);
    return json(snapshot);
  });

  // Members see only their own history and snippets; admins see the profile's.
  const ownerId = ctx.userRole === 'member' ? ctx.userId : undefined;

  handlers.set('sample_table', async (args) => {
    const table = argString(args, 'table').trim();
    if (!table) return toolError('The `table` argument is required.');
    await assertDatabaseAllowed(ctx.profileId, ctx.database, ctx.scopeOverride);
    const limit = Math.max(1, Math.min(Math.trunc(argNumber(args, 'limit', 10)), 20));
    const orderBy = argString(args, 'order_by').trim() || null;
    const result = await getTableData(ctx.profileId, ctx.database, table, {
      limit,
      orderBy,
      userId: ctx.userId,
    });
    return json({
      table,
      columns: result.columns.map((column) => column.name),
      rows: result.rows,
      rowCount: result.rowCount,
      truncated: result.truncated,
      masked: result.masked,
    });
  });

  handlers.set('list_objects', async () => {
    await assertDatabaseAllowed(ctx.profileId, ctx.database, ctx.scopeOverride);
    const objects = await getDatabaseObjects(ctx.profileId, ctx.database);
    return json({
      views: objects.views.map((view) => view.name),
      routines: objects.routines.map((routine) => `${routine.type} ${routine.name}`),
      triggers: objects.triggers.map((trigger) => trigger.name),
      events: objects.events.map((event) => event.name),
      counts: {
        tables: objects.tables.length,
        views: objects.views.length,
        routines: objects.routines.length,
        triggers: objects.triggers.length,
        events: objects.events.length,
      },
    });
  });

  handlers.set('get_object_definition', async (args) => {
    const type = argString(args, 'type').trim();
    const name = argString(args, 'name').trim();
    if (!name) return toolError('The `name` argument is required.');
    await assertDatabaseAllowed(ctx.profileId, ctx.database, ctx.scopeOverride);
    switch (type) {
      case 'view':
        return json(await getViewDefinition(ctx.profileId, ctx.database, name));
      case 'procedure':
        return json(await getRoutineDefinition(ctx.profileId, ctx.database, 'PROCEDURE', name));
      case 'function':
        return json(await getRoutineDefinition(ctx.profileId, ctx.database, 'FUNCTION', name));
      case 'trigger':
        return json(await getTriggerDefinition(ctx.profileId, ctx.database, name));
      case 'event':
        return json(await getEventDefinition(ctx.profileId, ctx.database, name));
      default:
        return toolError('`type` must be one of view, procedure, function, trigger, event.');
    }
  });

  handlers.set('index_advisor', async (args) => {
    const sql = argString(args, 'sql');
    if (!sql.trim()) return toolError('The `sql` argument is required.');
    await assertDatabaseAllowed(ctx.profileId, ctx.database, ctx.scopeOverride);
    const schema = await getSchemaSnapshot(ctx.profileId, ctx.database);
    const context = buildRuleContext({ sql, schema });
    return json({ suggestions: suggestIndexes(context) });
  });

  handlers.set('search_history', async (args) => {
    const query = argString(args, 'query').trim().toLowerCase();
    if (!query) return toolError('The `query` argument is required.');
    const entries = await listHistory(ctx.profileId, 500, ownerId);
    const matches = entries
      .filter(
        (entry) =>
          entry.sql.toLowerCase().includes(query) ||
          (entry.database ?? '').toLowerCase().includes(query),
      )
      .slice(0, 10)
      .map((entry) => ({
        sql: entry.sql,
        kind: entry.kind,
        database: entry.database,
        success: entry.success,
        executionMs: entry.executionMs,
        rowCount: entry.rowCount,
        error: entry.error ?? undefined,
        ranAt: entry.createdAt,
      }));
    return json({ matches, searchedEntries: entries.length });
  });

  handlers.set('find_snippet', async (args) => {
    const query = argString(args, 'query').trim().toLowerCase();
    if (!query) return toolError('The `query` argument is required.');
    const snippets = await listSnippets(ownerId);
    const matches = snippets
      .filter(
        (snippet) =>
          snippet.title.toLowerCase().includes(query) ||
          snippet.sql.toLowerCase().includes(query) ||
          snippet.tags.some((tag) => tag.toLowerCase().includes(query)),
      )
      .slice(0, 10)
      .map((snippet) => ({
        title: snippet.title,
        sql: snippet.sql,
        tags: snippet.tags,
        updatedAt: snippet.updatedAt,
      }));
    return json({ matches });
  });

  handlers.set('save_snippet', async (args) => {
    const title = argString(args, 'title').trim();
    const sql = argString(args, 'sql');
    if (!title) return toolError('The `title` argument is required.');
    if (!sql.trim()) return toolError('The `sql` argument is required.');
    const tags = Array.isArray(args.tags)
      ? args.tags.filter((tag): tag is string => typeof tag === 'string')
      : [];
    if (!ctx.userId) return toolError('Snippets need a signed-in user.');
    const snippet = await createSnippet({ title, sql, tags }, ctx.userId);
    return json({ saved: { title: snippet.title, tags: snippet.tags } });
  });

  handlers.set('slow_queries', async () => {
    if (!ctx.serverWide) {
      return toolError(
        'Server-wide insights are disabled for this connection, so the slow log and Performance Schema are off limits.',
      );
    }
    const server = getCachedServerInfo(ctx.profileId) ?? (await connectProfile(ctx.profileId));
    const variables = await getGlobalVariables(ctx.profileId);
    const slow = await getSlowQueries(
      ctx.profileId,
      server.capabilities.performanceSchema,
      variables,
    );
    return json({ source: slow.source, queries: slow.rows, advice: slow.advice ?? undefined });
  });

  handlers.set('security_audit', async () => {
    if (!ctx.serverWide) {
      return toolError(
        'Server-wide insights are disabled for this connection, so account and privilege data is off limits.',
      );
    }
    return json(await runSecurityAudit(ctx.profileId));
  });

  // Deliberately side-effect-free: the tool call itself is the delivery
  // mechanism — the client renders the arguments as a proposal card with
  // Insert/Copy actions. The agent never runs what it proposes.
  handlers.set('propose_sql', async (args) => {
    const sql = argString(args, 'sql');
    if (!sql.trim()) return toolError('The `sql` argument is required.');
    if (sql.length > PROPOSAL_SQL_MAX_CHARS) {
      return toolError(
        `The proposed statement is too large (${sql.length} chars); keep proposals under ${PROPOSAL_SQL_MAX_CHARS}.`,
      );
    }
    return json({ delivered: true, note: 'The proposal card is shown to the user.' });
  });

  return { definitions, handlers };
}

/**
 * Removes the tools an administrator has switched off. Applied after the
 * toolset is built so the definitions, the handlers and the advertised names
 * always agree — a tool that is known to the model but missing its handler
 * would just burn a round on an error.
 */
export function applyToolGovernance(toolset: AgentToolSet, disabled: string[]): AgentToolSet {
  if (disabled.length === 0) return toolset;
  const off = new Set(disabled);
  return {
    definitions: toolset.definitions.filter((tool) => !off.has(tool.name)),
    handlers: new Map([...toolset.handlers.entries()].filter(([name]) => !off.has(name))),
  };
}

/** The only tools the challenge coach gets — structure, never data. */
const COACH_TOOL_NAMES = new Set(['list_tables', 'describe_table', 'list_objects']);

/**
 * The toolset for the practice-lab coach.
 *
 * Deliberately narrower than the workspace set: no query execution, no
 * sampling, no server telemetry. Tool results are not screened by the
 * challenge guard — only the final text is — so anything that could carry
 * challenge data must not exist here. `ctx.tableFilter` confines the
 * remaining structure tools to the challenge's own tables.
 */
export function buildCoachTools(ctx: AgentToolContext): AgentToolSet {
  const workspace = buildWorkspaceTools(ctx);
  return {
    definitions: workspace.definitions.filter((tool) => COACH_TOOL_NAMES.has(tool.name)),
    handlers: new Map(
      [...workspace.handlers.entries()].filter(([name]) => COACH_TOOL_NAMES.has(name)),
    ),
  };
}
