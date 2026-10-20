import { describe, expect, it } from 'vitest';
import { parseAiReview } from '../server/ai/analyze';

const valid = {
  verdict: 'fail',
  score: 42,
  summary: 'The query scans the whole table.',
  findings: [
    {
      severity: 'critical',
      category: 'performance',
      title: 'Full table scan',
      detail: 'No index covers the predicate.',
      recommendation: 'Add an index on email.',
      line: 1,
      evidence: "WHERE email = 'a'",
      table: 'users',
      column: 'email',
    },
  ],
  rewrite: {
    sql: 'SELECT id FROM users WHERE email = ? LIMIT 10',
    explanation: 'Bind the value and add a limit.',
  },
};

describe('AI review parsing', () => {
  it('parses fenced JSON and normalizes findings', () => {
    const parsed = parseAiReview(`\`\`\`json\n${JSON.stringify(valid)}\n\`\`\``);
    expect(parsed).not.toBeNull();
    expect(parsed?.verdict).toBe('fail');
    expect(parsed?.score).toBe(42);
    expect(parsed?.findings).toHaveLength(1);
    expect(parsed?.findings[0]).toMatchObject({
      source: 'ai',
      severity: 'critical',
      category: 'performance',
      object: { table: 'users', column: 'email' },
    });
    expect(parsed?.rewrite?.sql).toContain('LIMIT 10');
  });

  it('accepts a review wrapper object', () => {
    const parsed = parseAiReview(JSON.stringify({ review: valid }));
    expect(parsed?.summary).toContain('whole table');
  });

  it('normalizes unknown severities and infers a verdict', () => {
    const parsed = parseAiReview(
      JSON.stringify({
        summary: 'Review',
        findings: [
          { title: 'Risky', severity: 'warning', detail: 'Be careful' },
          { title: 'Really risky', severity: 'nonsense', detail: 'More detail' },
        ],
      }),
    );
    expect(parsed?.verdict).toBe('warn');
    expect(parsed?.findings[0].severity).toBe('medium');
    expect(parsed?.findings[1].severity).toBe('medium');
  });

  it('returns null for non-JSON responses', () => {
    expect(parseAiReview('The query looks good to me.')).toBeNull();
    expect(parseAiReview('')).toBeNull();
  });

  it('clamps scores and rejects empty rewrites', () => {
    const parsed = parseAiReview(
      JSON.stringify({
        verdict: 'pass',
        score: 140,
        summary: 'Fine.',
        findings: [],
        rewrite: { sql: '   ', explanation: 'nothing' },
      }),
    );
    expect(parsed?.score).toBe(100);
    expect(parsed?.rewrite).toBeNull();
  });
});
