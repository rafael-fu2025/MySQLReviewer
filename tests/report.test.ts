import { describe, expect, it } from 'vitest';
import type { AuditReport, Finding } from '../shared/types';
import { groupFindings } from '../server/review/findings';
import { scoreFindings } from '../server/review/scoring';
import { reportFileName, reportToHtml, reportToMarkdown } from '../server/review/report';

const finding: Finding = {
  id: 'finding-1',
  ruleId: 'security.empty-password',
  title: 'Account has an empty password',
  severity: 'critical',
  category: 'security',
  message: 'root@localhost can authenticate without a password. <script>alert(1)</script>',
  recommendation: 'Set a strong password.',
  evidence: 'plugin=mysql_native_password',
  line: null,
  column: null,
  object: { user: 'root', host: 'localhost' },
  source: 'rule',
  confidence: 'high',
};

const report: AuditReport = {
  id: 'audit_test_123',
  kind: 'audit',
  title: 'Audit · shop',
  createdAt: '2026-10-20T00:00:00.000Z',
  profile: {
    id: 'xampp-local',
    name: 'XAMPP',
    host: '127.0.0.1',
    port: 3306,
    user: 'root',
  },
  databaseScope: ['shop'],
  server: null,
  score: scoreFindings([finding]),
  findingsTotal: 1,
  groups: groupFindings([finding]),
  coverage: [{ check: 'Schema snapshot', status: 'ran', count: 1 }],
  environment: {
    server_version: '10.4.32-MariaDB',
    sql_mode: 'NO_ZERO_DATE',
    secure_file_priv: 'NULL',
  },
  stats: {
    databases: 1,
    tables: 2,
    views: 0,
    routines: 0,
    triggers: 0,
    events: 0,
    columns: 10,
    indexes: 3,
    totalRowsEstimate: 100,
    totalBytes: 32_768,
  },
  ai: {
    providerId: 'provider-1',
    providerName: 'Test',
    model: 'test-model',
    verdict: 'unknown',
    score: null,
    summary: 'Overall summary',
    findings: [],
    rewrite: null,
    markdown: '## Executive summary\n\nThe local server is **wide open**.',
    usage: null,
    durationMs: 42,
  },
  durationMs: 1234,
  steps: [{ key: 'snapshot', label: 'Schema snapshot', status: 'done', durationMs: 10 }],
};

describe('report export', () => {
  it('renders a markdown report with score, coverage, and findings', () => {
    const markdown = reportToMarkdown(report);
    expect(markdown).toContain('# Audit · shop');
    expect(markdown).toContain('**70/100** (grade C)');
    expect(markdown).toContain('Schema snapshot');
    expect(markdown).toContain('security.empty-password');
    expect(markdown).toContain('## AI executive summary');
  });

  it('escapes HTML from findings and AI markdown', () => {
    const html = reportToHtml(report);
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('Audit · shop');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('Executive summary');
  });

  it('creates safe file names', () => {
    expect(reportFileName(report, 'md')).toBe('mylens-audit-audit_test_123.md');
    expect(reportFileName(report, 'html')).toBe('mylens-audit-audit_test_123.html');
  });
});
