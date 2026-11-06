/**
 * The catalog of built-in agent tools, shared by the server (governance
 * validation) and the Settings UI (the toggle list). The model-facing
 * descriptions live in `server/ai/agent-tools.ts`; these are the ones a
 * human reads.
 */
export interface AgentToolInfo {
  name: string;
  label: string;
  description: string;
}

export const AGENT_TOOLS: AgentToolInfo[] = [
  {
    name: 'list_tables',
    label: 'List tables',
    description: 'Enumerate the tables of the connected database.',
  },
  {
    name: 'describe_table',
    label: 'Describe table',
    description: 'Columns, indexes and options of one table.',
  },
  {
    name: 'explain_sql',
    label: 'Explain SQL',
    description: 'EXPLAIN (optionally ANALYZE) a SELECT statement.',
  },
  {
    name: 'run_readonly_query',
    label: 'Run read-only query',
    description: 'Execute one SELECT/SHOW/DESC statement, up to 50 rows, masked.',
  },
  {
    name: 'review_sql',
    label: 'Review SQL',
    description: 'Deterministic rule review of a statement.',
  },
  {
    name: 'server_status',
    label: 'Server status',
    description: 'Notable status counters and system variables.',
  },
  {
    name: 'process_list',
    label: 'Process list',
    description: 'Current server processes.',
  },
  {
    name: 'perf_snapshot',
    label: 'Performance snapshot',
    description: 'Status, process list and largest tables in one shot.',
  },
  {
    name: 'sample_table',
    label: 'Sample table',
    description: 'Preview up to 20 masked rows of one table.',
  },
  {
    name: 'list_objects',
    label: 'List objects',
    description: 'Views, routines, triggers and events of the database.',
  },
  {
    name: 'get_object_definition',
    label: 'Object definition',
    description: 'Full definition of one view, routine, trigger or event.',
  },
  {
    name: 'index_advisor',
    label: 'Index advisor',
    description: 'Suggest indexes for a statement from the real schema.',
  },
  {
    name: 'search_history',
    label: 'Search history',
    description: 'Find previously executed queries (literals redacted).',
  },
  {
    name: 'find_snippet',
    label: 'Find snippet',
    description: 'Search saved SQL snippets.',
  },
  {
    name: 'save_snippet',
    label: 'Save snippet',
    description: 'Persist a statement as a named snippet.',
  },
  {
    name: 'slow_queries',
    label: 'Slow queries',
    description: 'Top slow statements from Performance Schema or the slow log.',
  },
  {
    name: 'security_audit',
    label: 'Security audit',
    description: 'Accounts, privileges and security-relevant configuration.',
  },
  {
    name: 'propose_sql',
    label: 'SQL proposals',
    description:
      'Offer finished statements as clickable cards the user can insert into the editor.',
  },
];
