import { describe, expect, it, vi } from 'vitest';
import { buildRuleContext } from '../server/review/context';
import { dedupeFindings } from '../server/review/findings';
import {
  runConfigRules,
  runQuerySchemaRules,
  runSqlRules,
  RULE_CATALOG,
} from '../server/review/rules';
import { column, schema, table } from './fixtures';

/**
 * Records who calls the tokenizer, so the "tokenize the script once"
 * regression (R-14) can be observed rather than inferred.
 */
const { tokenizeCalls } = vi.hoisted(() => ({ tokenizeCalls: [] as string[] }));

vi.mock('../server/review/tokenizer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/review/tokenizer')>();
  return {
    ...actual,
    tokenize: (sql: string) => {
      // The first stack frame inside the review engine names the caller.
      const frame =
        (new Error().stack ?? '')
          .split('\n')
          .map((line) => line.trim())
          .find((line) => /[\\/]review[\\/]/.test(line)) ?? '';
      tokenizeCalls.push(frame);
      return actual.tokenize(sql);
    },
  };
});

const users = table('users', {
  rowsEstimate: 5_000,
  columns: [
    column('id', { key: 'PRI', extra: 'auto_increment' }),
    column('name', { dataType: 'varchar', columnType: 'varchar(255)', nullable: false }),
    column('email', { dataType: 'varchar', columnType: 'varchar(255)', nullable: true }),
  ],
  indexes: [
    {
      name: 'PRIMARY',
      unique: true,
      type: 'BTREE',
      columns: [{ name: 'id', subPart: null, collation: 'A' }],
      cardinality: 5_000,
      comment: '',
    },
    {
      name: 'idx_name',
      unique: false,
      type: 'BTREE',
      columns: [{ name: 'name', subPart: null, collation: 'A' }],
      cardinality: 5_000,
      comment: '',
    },
  ],
});

const orders = table('orders', {
  rowsEstimate: 50_000,
  columns: [
    column('id', { key: 'PRI', extra: 'auto_increment' }),
    column('amount', { dataType: 'decimal', columnType: 'decimal(10,2)', nullable: false }),
    column('status', { dataType: 'varchar', columnType: 'varchar(20)', nullable: false }),
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
  ],
});

const shopSchema = schema([users, orders]);

function review(sql: string) {
  const context = buildRuleContext({ sql, schema: shopSchema });
  return dedupeFindings([...runSqlRules(context), ...runQuerySchemaRules(context)]);
}

function ruleIds(sql: string): string[] {
  return review(sql).map((finding) => finding.ruleId);
}

/** True when any finding comes from the given rule, whatever its module prefix. */
function hasRule(sql: string, suffix: string): boolean {
  return ruleIds(sql).some((id) => id === suffix || id.endsWith(`.${suffix}`));
}

describe('R-01 · DDL column definitions are not validated against the schema', () => {
  it('does not report a column that ALTER TABLE creates as unknown', () => {
    expect(hasRule('ALTER TABLE users ADD COLUMN nickname VARCHAR(50)', 'unknown-column')).toBe(
      false,
    );
    expect(
      hasRule('ALTER TABLE users CHANGE COLUMN name fullname VARCHAR(255)', 'unknown-column'),
    ).toBe(false);
    expect(hasRule('ALTER TABLE users ADD INDEX idx_nickname (nickname)', 'unknown-column')).toBe(
      false,
    );
    // The DDL itself is still reported.
    expect(ruleIds('ALTER TABLE users ADD COLUMN nickname VARCHAR(50)')).toContain(
      'sql.alter-table',
    );
  });
});

describe('R-02 · statement identity survives the parser and the de-duplication', () => {
  it('keeps the table of UPDATE/DROP/TRUNCATE and never drops a critical finding', () => {
    const update = review("UPDATE users SET name = 'x'");
    expect(update.find((f) => f.ruleId === 'sql.update-without-where')?.object?.table).toBe(
      'users',
    );

    const drop = review('DROP TABLE users');
    expect(drop.find((f) => f.ruleId === 'sql.drop-statement')?.object?.table).toBe('users');

    const truncate = review('TRUNCATE TABLE users');
    expect(truncate.find((f) => f.ruleId === 'sql.truncate-statement')?.object?.table).toBe(
      'users',
    );

    // Two statements on one line: both critical findings must survive.
    const both = review("UPDATE users SET name = 'x'; UPDATE orders SET amount = 1;");
    const updates = both.filter((f) => f.ruleId === 'sql.update-without-where');
    expect(updates).toHaveLength(2);
    expect(updates.map((f) => f.object?.table).sort()).toEqual(['orders', 'users']);
  });
});

describe('R-03 · INSERT ... SET names its columns', () => {
  it('is not reported as an INSERT without a column list', () => {
    expect(ruleIds("INSERT INTO users SET name = 'a'")).not.toContain('sql.insert-without-columns');
    // A statement with neither a column list nor a SET clause still is.
    expect(ruleIds('INSERT INTO users VALUES (1, 2)')).toContain('sql.insert-without-columns');
  });
});

describe('R-04 · CTE and derived-table columns are not schema columns', () => {
  it('does not report a derived-table or CTE output column as unknown', () => {
    expect(
      hasRule('SELECT gross FROM (SELECT SUM(amount) AS gross FROM orders) d', 'unknown-column'),
    ).toBe(false);
    expect(
      hasRule(
        'WITH cte AS (SELECT id AS user_id FROM users) SELECT user_id FROM cte',
        'unknown-column',
      ),
    ).toBe(false);
  });
});

describe('R-05 · GROUP BY matches a qualified selected column', () => {
  it('does not report a column that is grouped under a different qualification', () => {
    expect(ruleIds('SELECT u.name, COUNT(*) FROM users u GROUP BY name')).not.toContain(
      'sql.group-by-nonaggregated',
    );
    // A column that is not grouped at all is still reported.
    expect(ruleIds('SELECT u.name, u.email, COUNT(*) FROM users u GROUP BY u.name')).toContain(
      'sql.group-by-nonaggregated',
    );
  });
});

describe('R-08 · a string literal is not a REGEXP operator', () => {
  it('ignores the word regexp inside a string', () => {
    expect(ruleIds("SELECT id FROM users WHERE name = 'regexp'")).not.toContain(
      'sql.regexp-predicate',
    );
    // A real predicate is still reported.
    expect(ruleIds("SELECT id FROM users WHERE name REGEXP '^a'")).toContain(
      'sql.regexp-predicate',
    );
  });
});

describe('R-09 · every UNION is checked on its own', () => {
  it('reports a plain UNION even when the script also contains a UNION ALL', () => {
    const ids = ruleIds(
      'SELECT id FROM users UNION SELECT id FROM orders UNION ALL SELECT id FROM users',
    );
    expect(ids).toContain('sql.union-without-all');
  });

  it('stays quiet when every UNION is a UNION ALL', () => {
    expect(ruleIds('SELECT id FROM users UNION ALL SELECT id FROM orders')).not.toContain(
      'sql.union-without-all',
    );
  });
});

describe('R-10 · NOT LIKE defeats a leading index just like LIKE', () => {
  it('reports a leading-wildcard NOT LIKE against an indexed column', () => {
    expect(
      hasRule("SELECT id FROM users WHERE name NOT LIKE '%bob%'", 'leading-wildcard-indexed'),
    ).toBe(true);
  });
});

describe('R-11 · the IPv6 wildcard bind is a wildcard', () => {
  it('reports bind_address = :: as network exposed', () => {
    const findings = runConfigRules({ bind_address: '::' }, null);
    expect(findings.map((f) => f.ruleId)).toContain('config.network-exposed');
  });

  it('stays quiet for a loopback bind', () => {
    const findings = runConfigRules({ bind_address: '127.0.0.1' }, null);
    expect(findings.map((f) => f.ruleId)).not.toContain('config.network-exposed');
  });
});

describe('R-12 · the catalog lists every rule the engine can emit', () => {
  it('contains the unused-index rule the audit produces', () => {
    const entry = RULE_CATALOG.find((rule) => rule.id === 'schema.unused-index');
    expect(entry).toBeDefined();
    expect(entry?.module).toBe('schema');
    expect(entry?.severity).toBe('low');
  });
});

describe('R-13 · rule ids are namespaced by module', () => {
  it('prefixes every query-schema rule with query-schema.', () => {
    const ids = RULE_CATALOG.filter((rule) => rule.module === 'query-schema').map(
      (rule) => rule.id,
    );
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      expect(id.startsWith('query-schema.')).toBe(true);
    }
    // The old, wrong prefix must be gone.
    expect(ids.some((id) => id.startsWith('sql.'))).toBe(false);
  });
});

describe('R-14 · the script is tokenized once per review', () => {
  it('runs the tokenizer a single time, and not from the context builder', () => {
    tokenizeCalls.length = 0;
    buildRuleContext({
      sql: "SELECT id FROM users WHERE name = 'x'; UPDATE users SET name = 'y';",
      schema: shopSchema,
    });
    expect(tokenizeCalls).toHaveLength(1);
    // The context builder must reuse the classifier's token list instead of
    // tokenizing the same script a second time.
    expect(tokenizeCalls[0]).not.toContain('context.ts');
  });
});
