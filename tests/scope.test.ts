import { describe, expect, it } from 'vitest';
import {
  collectReferencedDatabases,
  containsExecutableComment,
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

  it('collects the database of the SHOW variants that name one', () => {
    expect(collectReferencedDatabases('SHOW FULL TABLES FROM analytics')).toContain('analytics');
    expect(collectReferencedDatabases('SHOW TRIGGERS FROM analytics')).toContain('analytics');
    expect(collectReferencedDatabases('SHOW TABLE STATUS FROM analytics')).toContain('analytics');
    expect(collectReferencedDatabases('SHOW OPEN TABLES FROM analytics')).toContain('analytics');
    expect(collectReferencedDatabases('SHOW PROCEDURE STATUS FROM analytics')).toContain(
      'analytics',
    );
    expect(collectReferencedDatabases('SHOW INDEX FROM orders FROM analytics')).toContain(
      'analytics',
    );
    expect(collectReferencedDatabases('SHOW CREATE DATABASE analytics')).toContain('analytics');
  });

  it('spots a version comment, which the server executes', () => {
    expect(containsExecutableComment('SELECT 1 /*!50000 UNION SELECT 2 */')).toBe(true);
    expect(containsExecutableComment('SELECT * FROM /*!otherdb*/.users')).toBe(true);
    expect(containsExecutableComment('SELECT 1 /* a normal comment */')).toBe(false);
    // A version comment inside a string is only text.
    expect(containsExecutableComment("SELECT '/*!' AS note")).toBe(false);
  });

  it('finds a qualified name the SQL parser rejects', () => {
    // node-sql-parser cannot read this statement; the token scan still finds
    // the database in front of the table.
    expect(collectReferencedDatabases('SELECT * FROM `se`cret`.`t`').size).toBeGreaterThan(0);
  });
});
