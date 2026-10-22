import { describe, expect, it } from 'vitest';
import { buildRuleContext } from '../server/review/context';
import { suggestIndexes } from '../server/review/index-advisor';
import { column, schema, table } from './fixtures';

function usersTable(withCompositeIndex = false) {
  return table('users', {
    rowsEstimate: 50_000,
    columns: [
      column('id', { key: 'PRI', extra: 'auto_increment' }),
      column('email', {
        dataType: 'varchar',
        columnType: 'varchar(255)',
        nullable: false,
      }),
      column('status', {
        dataType: 'varchar',
        columnType: 'varchar(20)',
        nullable: false,
      }),
    ],
    indexes: [
      {
        name: 'PRIMARY',
        unique: true,
        type: 'BTREE',
        columns: [{ name: 'id', subPart: null, collation: 'A' }],
        cardinality: 50_000,
        comment: '',
      },
      ...(withCompositeIndex
        ? [
            {
              name: 'idx_email_status',
              unique: false,
              type: 'BTREE',
              columns: [
                { name: 'email', subPart: null, collation: 'A' },
                { name: 'status', subPart: null, collation: 'A' },
              ],
              cardinality: 50_000,
              comment: '',
            },
          ]
        : []),
    ],
  });
}

function suggest(withCompositeIndex: boolean) {
  const context = buildRuleContext({
    sql: "SELECT id FROM users WHERE email = 'a' ORDER BY status LIMIT 10",
    schema: schema([usersTable(withCompositeIndex)]),
  });
  return suggestIndexes(context);
}

describe('index advisor', () => {
  it('suggests a composite index for equality plus ordering', () => {
    const suggestions = suggest(false);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].table).toBe('users');
    expect(suggestions[0].columns).toEqual(['email', 'status']);
    expect(suggestions[0].statement).toContain('ALTER TABLE');
    expect(suggestions[0].confidence).toBe('high');
  });

  it('does not suggest an already-covered index', () => {
    expect(suggest(false).length).toBeGreaterThan(0);
    expect(suggest(true)).toHaveLength(0);
  });
});
