import type {
  AiChatMessage,
  AuditEnvironment,
  AuditStats,
  ExplainResult,
  Finding,
  FindingGroup,
  ScoreResult,
  ServerInfo,
} from '../../shared/types';
import type { ChatMessage } from './http';

export interface ReviewPromptInput {
  sql: string;
  server: ServerInfo | null;
  database: string | null;
  schemaText: string;
  schemaTruncated: boolean;
  findings: Finding[];
  explain: ExplainResult | null;
}

function serverLine(server: ServerInfo | null): string {
  if (!server) return 'unknown';
  return `${server.version} (${server.flavor}) · sql_mode=${server.sqlMode || '(empty)'}`;
}

export function explainToText(explain: ExplainResult | null): string {
  if (!explain) return 'No EXPLAIN data.';
  const lines: string[] = [];
  const walk = (nodes: typeof explain.nodes, depth = 0): void => {
    for (const node of nodes) {
      if (node.table) {
        lines.push(
          `${'  '.repeat(depth)}- ${node.table}: access=${node.accessType ?? 'n/a'} key=${node.key ?? 'none'} possible=${node.possibleKeys.join(',') || 'none'} rows=${node.rows ?? 'n/a'} filtered=${node.filtered ?? 'n/a'} cost=${node.cost ?? 'n/a'}${node.runtimeRows != null ? ` runtime_rows=${node.runtimeRows}` : ''}${node.extra.length ? ` [${node.extra.join('; ')}]` : ''}`,
        );
      }
      walk(node.children, depth + 1);
    }
  };
  walk(explain.nodes);
  if (lines.length === 0) lines.push('No table nodes were returned.');
  if (explain.insights.length > 0) {
    lines.push('Plan warnings:');
    for (const finding of explain.insights.slice(0, 20)) {
      lines.push(`- [${finding.severity}] ${finding.title}: ${finding.message}`);
    }
  }
  return lines.join('\n');
}

function findingsToText(findings: Finding[]): string {
  if (findings.length === 0) return 'None.';
  return findings
    .slice(0, 60)
    .map(
      (finding) =>
        `- [${finding.severity}/${finding.category}] ${finding.ruleId}${finding.line ? ` (line ${finding.line})` : ''}: ${finding.title} — ${finding.message}`,
    )
    .join('\n');
}

const REVIEW_SCHEMA = `{
  "verdict": "pass" | "warn" | "fail",
  "score": 0-100,
  "summary": "2-4 sentences describing the most important risks and the overall quality",
  "findings": [
    {
      "severity": "critical" | "high" | "medium" | "low" | "info",
      "category": "correctness" | "performance" | "security" | "schema" | "style" | "maintainability",
      "title": "short imperative title",
      "detail": "specific explanation with evidence from the SQL or schema",
      "recommendation": "concrete fix or next step",
      "line": 1,
      "evidence": "optional short snippet or value",
      "table": "optional table name",
      "column": "optional column name"
    }
  ],
  "rewrite": {
    "sql": "a complete replacement statement, or null",
    "explanation": "what changed and why"
  }
}`;

export function buildReviewMessages(input: ReviewPromptInput): ChatMessage[] {
  const system = `You are MyLens, a senior MySQL and MariaDB reviewer. You analyze one SQL script at a time for correctness, data safety, security, performance, schema fit, and maintainability.

Rules:
- Be specific and technical. Never give generic advice that could apply to any query.
- Use only the schema context provided. If a table or column is missing, say so instead of inventing it.
- Respect the exact server flavor and version. Do not recommend syntax or features the server does not support.
- The deterministic findings are hints. Confirm them, correct false positives, and add important issues they missed.
- Never suggest executing destructive SQL. A rewrite is a suggestion for the user to review, not an action.
- If the SQL is sound, return verdict "pass" with an empty findings array.
- Line numbers are 1-based when identifiable, otherwise null.
- Return ONLY one JSON object with this shape, without markdown fences or commentary:
${REVIEW_SCHEMA}`;

  const sections: string[] = [
    `SERVER: ${serverLine(input.server)}`,
    `DATABASE: ${input.database ?? '(none selected)'}`,
    '',
    'SCHEMA CONTEXT:',
    input.schemaText || 'No schema context available.',
    input.schemaTruncated ? '-- schema context was truncated to fit the token budget' : '',
    '',
    'DETERMINISTIC FINDINGS:',
    findingsToText(input.findings),
    '',
    'EXPLAIN SUMMARY:',
    explainToText(input.explain),
    '',
    'SQL:',
    '```sql',
    input.sql,
    '```',
  ].filter(Boolean);

  return [
    { role: 'system', content: system },
    { role: 'user', content: sections.join('\n') },
  ];
}

export interface ChatPromptInput {
  messages: AiChatMessage[];
  sql?: string | null;
  database: string | null;
  server: ServerInfo | null;
  schemaText: string;
}

export function buildChatMessages(input: ChatPromptInput): ChatMessage[] {
  const system = `You are MyLens, a senior MySQL/MariaDB engineer embedded in a local review studio. You answer follow-up questions about the current SQL and schema.

- Be concrete and version-aware. Use the supplied schema only; do not invent tables or columns.
- You have not executed anything. Do not claim that a query ran or that a result is real.
- Prefer short, actionable answers with SQL snippets where useful.
- Use code blocks for SQL. Keep other formatting minimal.

SERVER: ${serverLine(input.server)}
DATABASE: ${input.database ?? '(none selected)'}
${input.sql ? `CURRENT SQL:\n\`\`\`sql\n${input.sql}\n\`\`\`` : ''}
SCHEMA CONTEXT:
${input.schemaText || 'No schema context available.'}`;

  const conversation = input.messages
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .slice(-20)
    .map((message) => ({
      role: message.role,
      content: message.content.slice(0, 20_000),
    }));

  if (!conversation.some((message) => message.role === 'user')) {
    conversation.push({ role: 'user', content: 'Explain the current query and its main risks.' });
  }

  return [{ role: 'system', content: system }, ...conversation];
}

export interface AuditSummaryInput {
  databases: string[];
  server: ServerInfo | null;
  score: ScoreResult;
  stats: AuditStats;
  environment: AuditEnvironment;
  groups: FindingGroup[];
}

export function buildAuditSummaryMessages(input: AuditSummaryInput): ChatMessage[] {
  const system = `You are MyLens, a senior MySQL/MariaDB consultant writing the executive summary of a database audit.

Write concise markdown for a developer or DBA:
1. Overall health (1-2 sentences, reference the score and grade).
2. Top risks (at most 5), ordered by real-world impact, with the affected rule or object.
3. Likely root causes or patterns, not a restatement of every finding.
4. Prioritized next actions (at most 6), separating quick wins from larger work.
5. Coverage gaps or unavailable checks that limit confidence.

Do not invent findings, tables, or metrics. If a category has no findings, say it is clean. Keep it under 450 words.`;

  const envLines = Object.entries(input.environment)
    .slice(0, 40)
    .map(([key, value]) => `- ${key}: ${value ?? 'null'}`);

  const groupLines = input.groups
    .slice(0, 30)
    .map(
      (group) =>
        `- [${group.severity}/${group.category}] ${group.ruleId} (${group.count}×): ${group.title}`,
    );

  const user = [
    `DATABASES: ${input.databases.join(', ') || '(none)'}`,
    `SERVER: ${serverLine(input.server)}`,
    `SCORE: ${input.score.score}/100 (grade ${input.score.grade})`,
    `COUNTS: critical=${input.score.counts.critical} high=${input.score.counts.high} medium=${input.score.counts.medium} low=${input.score.counts.low} info=${input.score.counts.info}`,
    `STATS: ${JSON.stringify(input.stats)}`,
    '',
    'ENVIRONMENT:',
    ...envLines,
    '',
    'TOP FINDING GROUPS:',
    ...(groupLines.length ? groupLines : ['- No findings.']),
  ].join('\n');

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

export function buildRepairMessages(original: ChatMessage[], raw: string): ChatMessage[] {
  return [
    ...original,
    { role: 'assistant', content: raw.slice(0, 30_000) },
    {
      role: 'user',
      content: `Your previous response was not valid JSON. Return the same review again as exactly one JSON object matching the required shape. Start with { and end with }. No markdown fences, no prose.`,
    },
  ];
}
