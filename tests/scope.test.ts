import { describe, expect, it } from 'vitest';
import {
  collectReferencedDatabases,
  filterDatabasesByScope,
  type DatabaseScope,
} from '../server/db/scope';
import type { DatabaseInfo } from '../shared/types';

function database(name: string): DatabaseInfo {
  return {
    name,
    isSystem: false,
    tableCount: 1,
    viewCount: 0,
    sizeBytes: 1024,
    collation: 'utf8mb4_general_ci',
  };
}

describe('database scope', () => {
  it('filters databases for a selected scope', () => {
    const scope: DatabaseScope = {
      mode: 'selected',
      allowed: new Set(['shop']),
      serverWideInsights: false,
    };
    expect(filterDatabasesByScope([database('shop'), database('other')], scope)).toEqual([
      database('shop'),
    ]);
  });

  it('returns all databases for an unrestricted scope', () => {
    const scope: DatabaseScope = {
      mode: 'all',
      allowed: new Set(),
      serverWideInsights: true,
    };
    const dbs = [database('shop'), database('other')];
    expect(filterDatabasesByScope(dbs, scope)).toHaveLength(2);
  });

  it('collects qualified table references', () => {
    expect(collectReferencedDatabases('SELECT * FROM shop.users')).toEqual(new Set(['shop']));
    expect(
      collectReferencedDatabases(
        'SELECT u.id FROM shop.users u JOIN analytics.orders o ON o.user_id = u.id',
      ),
    ).toEqual(new Set(['shop', 'analytics']));
  });

  it('handles CTEs without treating the CTE name as a database', () => {
    expect(
      collectReferencedDatabases('WITH recent AS (SELECT * FROM shop.orders) SELECT * FROM recent'),
    ).toEqual(new Set(['shop']));
  });

  it('handles SHOW statements', () => {
    expect(collectReferencedDatabases('SHOW TABLES FROM analytics')).toEqual(
      new Set(['analytics']),
    );
    expect(collectReferencedDatabases('SHOW COLUMNS FROM users')).toEqual(new Set());
    expect(collectReferencedDatabases('SHOW COLUMNS FROM analytics.users')).toEqual(
      new Set(['analytics']),
    );
    expect(collectReferencedDatabases('SHOW DATABASES')).toContain('__all_databases__');
    expect(collectReferencedDatabases('SHOW PROCESSLIST')).toContain('__processlist__');
    expect(collectReferencedDatabases('SHOW GRANTS')).toContain('__grants__');
    expect(collectReferencedDatabases('SHOW CREATE USER root@localhost')).toContain('__accounts__');
  });
});
