import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  executeQuery: vi.fn(),
  listTables: vi.fn(),
  getTableDetail: vi.fn(),
  getTableData: vi.fn(),
  getDatabaseObjects: vi.fn(),
  getObjectDefinition: vi.fn(),
  getSchemaSnapshot: vi.fn(),
  runExplain: vi.fn(),
  runStaticReview: vi.fn(),
  runSecurityAudit: vi.fn(),
  getSlowQueries: vi.fn(),
  getGlobalVariables: vi.fn().mockResolvedValue({}),
  getCachedServerInfo: vi.fn(),
  connectProfile: vi.fn(),
  listHistory: vi.fn(),
  listSnippets: vi.fn(),
  createSnippet: vi.fn(),
  suggestIndexes: vi.fn(),
  buildRuleContext: vi.fn(),
  getSettings: vi.fn().mockResolvedValue({ queryTimeoutMs: 30_000, rowLimit: 1_000 }),
}));

vi.mock('../server/db/query', () => ({ executeQuery: h.executeQuery }));
vi.mock('../server/db/introspection', () => ({
  listTables: h.listTables,
  getTableDetail: h.getTableDetail,
  getTableData: h.getTableData,
  getDatabaseObjects: h.getDatabaseObjects,
  getViewDefinition: h.getObjectDefinition,
  getRoutineDefinition: h.getObjectDefinition,
  getTriggerDefinition: h.getObjectDefinition,
  getEventDefinition: h.getObjectDefinition,
  getSchemaSnapshot: h.getSchemaSnapshot,
}));
vi.mock('../server/db/scope', () => ({ assertDatabaseAllowed: vi.fn() }));
vi.mock('../server/db/metrics', () => ({
  getGlobalStatus: vi.fn().mockResolvedValue({}),
  getGlobalVariables: h.getGlobalVariables,
  getPerformanceSnapshot: vi.fn().mockResolvedValue({}),
  getProcessList: vi.fn().mockResolvedValue([]),
  getSlowQueries: h.getSlowQueries,
}));
vi.mock('../server/db/manager', () => ({
  getCachedServerInfo: h.getCachedServerInfo,
  connectProfile: h.connectProfile,
}));
vi.mock('../server/db/explain', () => ({ runExplain: h.runExplain }));
vi.mock('../server/db/security-audit', () => ({ runSecurityAudit: h.runSecurityAudit }));
vi.mock('../server/review/static-review', () => ({ runStaticReview: h.runStaticReview }));
vi.mock('../server/review/context', () => ({ buildRuleContext: h.buildRuleContext }));
vi.mock('../server/review/index-advisor', () => ({ suggestIndexes: h.suggestIndexes }));
vi.mock('../server/store/history', () => ({ listHistory: h.listHistory }));
vi.mock('../server/store/snippets', () => ({
  listSnippets: h.listSnippets,
  createSnippet: h.createSnippet,
}));
vi.mock('../server/store/settings', () => ({ getSettings: h.getSettings }));

import {
  applyToolGovernance,
  buildCoachTools,
  buildWorkspaceTools,
  truncateToolOutput,
  type AgentToolContext,
} from '../server/ai/agent-tools';

const ctx: AgentToolContext = {
  profileId: 'p1',
  database: 'shop',
  serverWide: true,
  userRole: 'admin',
  userId: 'u1',
};

function handler(name: string, over: Partial<AgentToolContext> = {}) {
  const tools = buildWorkspaceTools({ ...ctx, ...over });
  const found = tools.handlers.get(name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
}

beforeEach(() => {
  for (const mock of Object.values(h)) mock.mockReset();
  h.getSettings.mockResolvedValue({ queryTimeoutMs: 30_000, rowLimit: 1_000 });
});

describe('agent tools', () => {
  it('offers the full workspace toolkit', () => {
    const tools = buildWorkspaceTools(ctx);
    expect(tools.definitions.map((tool) => tool.name)).toEqual([
      'list_tables',
      'describe_table',
      'explain_sql',
      'run_readonly_query',
      'review_sql',
      'server_status',
      'process_list',
      'perf_snapshot',
      'sample_table',
      'list_objects',
      'get_object_definition',
      'index_advisor',
      'search_history',
      'find_snippet',
      'save_snippet',
      'slow_queries',
      'security_audit',
      'propose_sql',
    ]);
    for (const definition of tools.definitions) {
      expect(definition.description.trim().length).toBeGreaterThan(10);
    }
  });

  it('refuses a write through the read-only tool without touching the database', async () => {
    const result = JSON.parse(await handler('run_readonly_query')({ sql: 'DELETE FROM users' }));
    expect(result.error).toContain('read');
    expect(h.executeQuery).not.toHaveBeenCalled();
  });

  it('refuses multiple statements in one tool call', async () => {
    const result = JSON.parse(await handler('run_readonly_query')({ sql: 'SELECT 1; SELECT 2' }));
    expect(result.error).toContain('one statement');
    expect(h.executeQuery).not.toHaveBeenCalled();
  });

  it('executes a read with the row cap and the caller scope', async () => {
    h.executeQuery.mockResolvedValueOnce({
      columns: [{ name: 'id' }],
      rows: [[1]],
      rowCount: 1,
      truncated: false,
    });
    const raw = await handler('run_readonly_query')({ sql: 'SELECT id FROM users', max_rows: 500 });
    const result = JSON.parse(raw);
    expect(result.columns).toEqual(['id']);
    expect(result.rows).toEqual([[1]]);
    expect(h.executeQuery).toHaveBeenCalledWith(
      'p1',
      'SELECT id FROM users',
      expect.objectContaining({ database: 'shop', rowLimit: 50 }),
    );
  });

  it('caps a table sample at 20 rows and reports masking', async () => {
    h.getTableData.mockResolvedValueOnce({
      columns: [{ name: 'email' }],
      rows: [['***']],
      rowCount: 1,
      truncated: false,
      masked: true,
    });
    const result = JSON.parse(
      await handler('sample_table')({ table: 'users', limit: 500, order_by: 'id' }),
    );
    expect(result.masked).toBe(true);
    expect(h.getTableData).toHaveBeenCalledWith(
      'p1',
      'shop',
      'users',
      expect.objectContaining({ limit: 20, orderBy: 'id' }),
    );
  });

  it('routes object definitions by type', async () => {
    h.getObjectDefinition.mockResolvedValue({ name: 'v_sales', definition: 'SELECT 1' });
    const view = JSON.parse(
      await handler('get_object_definition')({ type: 'view', name: 'v_sales' }),
    );
    expect(view.definition).toBe('SELECT 1');
    const routine = JSON.parse(
      await handler('get_object_definition')({ type: 'procedure', name: 'do_thing' }),
    );
    expect(routine.name).toBe('v_sales');
    const bad = JSON.parse(await handler('get_object_definition')({ type: 'table', name: 'x' }));
    expect(bad.error).toContain('type');
  });

  it('advises indexes from the real schema snapshot', async () => {
    h.getSchemaSnapshot.mockResolvedValue({ database: 'shop', tables: [] });
    h.buildRuleContext.mockReturnValue({});
    h.suggestIndexes.mockReturnValue([
      { table: 'orders', columns: ['customer_id'], confidence: 'high', statement: 'ALTER TABLE …' },
    ]);
    const result = JSON.parse(await handler('index_advisor')({ sql: 'SELECT * FROM orders' }));
    expect(result.suggestions[0].confidence).toBe('high');
    expect(h.buildRuleContext).toHaveBeenCalledWith(
      expect.objectContaining({
        sql: 'SELECT * FROM orders',
        schema: { database: 'shop', tables: [] },
      }),
    );
  });

  it('searches history case-insensitively and caps results', async () => {
    h.listHistory.mockResolvedValue([
      {
        sql: 'SELECT * FROM orders',
        kind: 'read',
        database: 'shop',
        success: true,
        executionMs: 5,
        rowCount: 2,
        error: null,
        createdAt: 't1',
      },
      {
        sql: 'UPDATE payments SET x = 1',
        kind: 'write',
        database: 'shop',
        success: true,
        executionMs: 5,
        rowCount: 1,
        error: null,
        createdAt: 't2',
      },
    ]);
    const result = JSON.parse(await handler('search_history')({ query: 'ORDERS' }));
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].sql).toBe('SELECT * FROM orders');
  });

  it('scopes history to the member who ran it', async () => {
    h.listHistory.mockResolvedValue([]);
    await handler('search_history', { userRole: 'member', userId: 'u9' })({ query: 'x' });
    expect(h.listHistory).toHaveBeenCalledWith('p1', 500, 'u9');
  });

  it('saves snippets under the calling user', async () => {
    h.createSnippet.mockResolvedValueOnce({ title: 'Monthly revenue', tags: ['report'] });
    const result = JSON.parse(
      await handler('save_snippet', { userId: 'u1' })({
        title: 'Monthly revenue',
        sql: 'SELECT 1',
      }),
    );
    expect(result.saved.title).toBe('Monthly revenue');
    expect(h.createSnippet).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Monthly revenue' }),
      'u1',
    );
  });

  it('refuses server-wide tools when the connection disallows them', async () => {
    const result = JSON.parse(await handler('security_audit', { serverWide: false })({}));
    expect(result.error).toContain('Server-wide');
    expect(h.runSecurityAudit).not.toHaveBeenCalled();
    expect(h.getSlowQueries).not.toHaveBeenCalled();
  });

  it('runs the security audit through the shared composition', async () => {
    h.runSecurityAudit.mockResolvedValueOnce({ findings: [], users: [] });
    const result = JSON.parse(await handler('security_audit')({}));
    expect(result.users).toEqual([]);
    expect(h.runSecurityAudit).toHaveBeenCalledWith('p1');
  });

  it('returns slow queries with their source', async () => {
    h.getCachedServerInfo.mockReturnValue({ capabilities: { performanceSchema: true } });
    h.getGlobalVariables.mockResolvedValue({});
    h.getSlowQueries.mockResolvedValueOnce({
      rows: [{ digest: 'd1' }],
      source: 'performance_schema',
      advice: null,
    });
    const result = JSON.parse(await handler('slow_queries')({}));
    expect(result.source).toBe('performance_schema');
    expect(result.queries).toHaveLength(1);
  });

  it('returns a readable error for a missing table argument', async () => {
    const result = JSON.parse(await handler('describe_table')({}));
    expect(result.error).toContain('table');
  });

  it('truncates oversized tool output with a marker', () => {
    const truncated = truncateToolOutput('x'.repeat(20_000));
    expect(truncated.length).toBeLessThan(9_000);
    expect(truncated).toContain('truncated');
  });

  it('governance removes a tool from definitions and handlers together', () => {
    const tools = buildWorkspaceTools(ctx);
    const governed = applyToolGovernance(tools, ['run_readonly_query', 'security_audit']);
    const names = governed.definitions.map((tool) => tool.name);
    expect(names).not.toContain('run_readonly_query');
    expect(names).not.toContain('security_audit');
    expect(governed.handlers.has('run_readonly_query')).toBe(false);
    expect(governed.handlers.has('list_tables')).toBe(true);
    expect(names).toHaveLength(tools.definitions.length - 2);
  });

  it('governance is a no-op with an empty disable list', () => {
    const tools = buildWorkspaceTools(ctx);
    expect(applyToolGovernance(tools, [])).toBe(tools);
  });

  it('delivers propose_sql without side effects', async () => {
    const result = JSON.parse(
      await handler('propose_sql')({ title: 'Add index', sql: 'CREATE INDEX i ON t (c)' }),
    );
    expect(result.delivered).toBe(true);
  });

  it('rejects an empty or oversized proposal', async () => {
    const empty = JSON.parse(await handler('propose_sql')({ title: 'x', sql: '  ' }));
    expect(empty.error).toContain('required');
    const huge = JSON.parse(
      await handler('propose_sql')({ title: 'x', sql: 'SELECT '.padEnd(20_001, '1') }),
    );
    expect(huge.error).toContain('too large');
  });

  it('coach tools are structure-only', () => {
    const coach = buildCoachTools(ctx);
    expect(coach.definitions.map((tool) => tool.name)).toEqual([
      'list_tables',
      'describe_table',
      'list_objects',
    ]);
    expect(coach.handlers.has('run_readonly_query')).toBe(false);
    expect(coach.handlers.has('sample_table')).toBe(false);
    expect(coach.handlers.has('propose_sql')).toBe(false);
  });

  it('the coach table leash hides foreign tables and blocks describing them', async () => {
    h.listTables.mockResolvedValue([
      {
        name: 'orders',
        type: 'BASE TABLE',
        engine: 'InnoDB',
        rowsEstimate: 10,
        dataBytes: 1,
        indexBytes: 0,
        comment: '',
      },
      {
        name: 'answers',
        type: 'BASE TABLE',
        engine: 'InnoDB',
        rowsEstimate: 10,
        dataBytes: 1,
        indexBytes: 0,
        comment: '',
      },
    ]);
    const coach = buildCoachTools({ ...ctx, tableFilter: ['orders'] });

    const listing = JSON.parse(await coach.handlers.get('list_tables')!({}));
    expect(listing.tables.map((table: { name: string }) => table.name)).toEqual(['orders']);

    const blocked = JSON.parse(await coach.handlers.get('describe_table')!({ table: 'answers' }));
    expect(blocked.error).toContain('challenge');

    h.getTableDetail.mockResolvedValueOnce({
      summary: {
        name: 'orders',
        type: 'BASE TABLE',
        engine: 'InnoDB',
        rowsEstimate: 10,
        dataBytes: 1,
        indexBytes: 0,
        comment: '',
      },
      columns: [],
      indexes: [],
      foreignKeys: [],
      createSql: null,
    });
    const allowed = JSON.parse(await coach.handlers.get('describe_table')!({ table: 'orders' }));
    expect(allowed.summary.name).toBe('orders');
  });
});
