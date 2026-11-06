import { describe, expect, it } from 'vitest';

import { challengeSchemaIdentifiers, screenChallengeAnswer } from '../server/ai/assistant';

const identifiers = challengeSchemaIdentifiers([
  { name: 'orders', columns: [{ name: 'total' }, { name: 'status' }] },
  { name: 'customers', columns: [{ name: 'name' }] },
]);

/**
 * The challenge tutor must not hand over the answer. The guard is the last
 * line of defence: the reference solution never reaches the prompt, and the
 * answer is screened before it is shown.
 */
describe('the challenge answer guard', () => {
  it('collects the identifiers of the challenge schema', () => {
    expect(identifiers.tables).toEqual(['orders', 'customers']);
    expect(identifiers.columns).toEqual(['total', 'status', 'name']);
  });

  it('refuses a SQL code fence that names a challenge table', () => {
    const result = screenChallengeAnswer({
      text: 'Here you go:\n```sql\nSELECT * FROM orders;\n```',
      identifiers,
    });
    expect(result.safe).toBe(false);
    expect(result.reason).toBe('sql-statement-detected');
  });

  it('refuses a SQL code fence that names a challenge column', () => {
    const result = screenChallengeAnswer({
      text: '```sql\nSELECT SUM(total) FROM orders;\n```',
      identifiers,
    });
    expect(result.safe).toBe(false);
  });

  it('refuses a statement on a line of its own', () => {
    const result = screenChallengeAnswer({
      text: 'Try this:\nSELECT * FROM orders\nThat should work.',
      identifiers,
    });
    expect(result.safe).toBe(false);
    expect(result.reason).toBe('sql-statement-detected');
  });

  it('refuses a near-copy of the reference solution', () => {
    const result = screenChallengeAnswer({
      text: 'The answer is:\nSELECT c.name, SUM(o.total) FROM customers c JOIN orders o ON o.cid = c.id GROUP BY c.name',
      referenceSql:
        'SELECT c.name, SUM(o.total) FROM customers c JOIN orders o ON o.cid = c.id GROUP BY c.name',
      identifiers,
    });
    expect(result.safe).toBe(false);
  });

  it('refuses an empty answer', () => {
    const result = screenChallengeAnswer({ text: '   ', identifiers });
    expect(result.safe).toBe(false);
    expect(result.reason).toBe('empty-answer');
  });

  it('allows a genuine hint that names no challenge table or column', () => {
    const result = screenChallengeAnswer({
      text: 'Start by thinking about which aggregation the question is asking for.',
      identifiers,
    });
    expect(result.safe).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it('allows a hint that mentions a word that is only a substring of a column', () => {
    // "name" is a challenge column, but this sentence does not contain it.
    const result = screenChallengeAnswer({
      text: 'Try reading the question again and check the units.',
      identifiers,
    });
    expect(result.safe).toBe(true);
  });
});
