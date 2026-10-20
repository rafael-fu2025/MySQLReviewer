import { describe, expect, it } from 'vitest';
import {
  buildContextInfo,
  buildRuleContext,
  schemaToText,
} from '../server/review/context';
import { column, schema, table } from './fixtures';

const users = table('users', {
  columns: [
    column('id', { key: 'PRI', extra: 'auto_increment' }),
    column('email', { dataType: 'varchar', columnType: 'varchar(255)', nullable: false }),
  ],
});
const orders = table('orders', {
  columns: [
    column('id', { key: 'PRI', extra: 'auto_increment' }),
    column('user_id', { dataType: 'int' }),
  ],
  foreignKeys: [
    {
      name: 'fk_orders_user',
      columns: ['user_id'],
      referencedDatabase: 'shop',
      referencedTable: 'users',
      referencedColumns: ['id'],
      onUpdate: 'RESTRICT',
      onDelete: 'CASCADE',
    },
  ],
});

describe('review context', () => {
  it('resolves tables and aliases from a join', () => {
    const context = buildRuleContext({
      sql: 'SELECT u.id FROM users u JOIN orders o ON o.user_id = u.id',
      database: 'shop',
      schema: schema([users, orders]),
      server: null,
    });
    expect(context.referencedTables.sort()).toEqual(['orders', 'users']);
    expect(context.tableLookup.get('u')?.name).toBe('users');
    expect(context.tableLookup.get('o')?.name).toBe('orders');
    expect(context.aliases.get('u')).toBe('users');
  });

  it('builds bounded context info', () => {
    const context = buildRuleContext({
      sql: 'SELECT * FROM users',
      database: 'shop',
      schema: schema([users, orders]),
      server: null,
    });
    const info = buildContextInfo(context.tables, 'shop');
    expect(info.tables).toHaveLength(1);
    expect(info.estimatedTokens).toBeGreaterThan(0);
    expect(info.charCount).toBeGreaterThan(0);
  });

  it('renders schema text with columns and indexes', () => {
    const text = schemaToText([users]);
    expect(text).toContain('TABLE `shop`.`users`');
    expect(text).toContain('`email` varchar(255) NOT NULL');
    expect(text).toContain('KEY `PRIMARY`');
  });

  it('returns an empty context for unknown tables', () => {
    const context = buildRuleContext({
      sql: 'SELECT * FROM missing',
      database: 'shop',
      schema: schema([users]),
      server: null,
    });
    expect(context.tables).toHaveLength(0);
  });
});
