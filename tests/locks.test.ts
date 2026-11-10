import { describe, expect, it } from 'vitest';
import { buildLockWaitsSql, lockWaitsSource, shapeLockWaitRow, type Row } from '../server/db/locks';

/**
 * mysql2 rows carry a nominal constructor marker; fixtures are plain objects,
 * so each one goes through this cast.
 */
function row(value: Record<string, unknown>): Row {
  return value as Row;
}

describe('lockWaitsSource', () => {
  it('reads performance_schema on MySQL 8', () => {
    expect(lockWaitsSource('mysql', '8.0.36')).toBe('data_lock_waits');
    expect(lockWaitsSource('mysql', '8.4.2')).toBe('data_lock_waits');
  });

  it('falls back to the information_schema plugin tables on MySQL 5.7', () => {
    expect(lockWaitsSource('mysql', '5.7.44')).toBe('innodb_lock_waits');
    expect(lockWaitsSource('mysql', '5.6.51')).toBe('innodb_lock_waits');
  });

  it('uses data_lock_waits once MariaDB gained it (10.5), plugin tables before', () => {
    expect(lockWaitsSource('mariadb', '10.5.16-MariaDB')).toBe('data_lock_waits');
    expect(lockWaitsSource('mariadb', '11.4.5-MariaDB')).toBe('data_lock_waits');
    expect(lockWaitsSource('mariadb', '10.4.32-MariaDB')).toBe('innodb_lock_waits');
    // MariaDB removed INNODB_LOCKS/INNODB_LOCK_WAITS in 10.6, so the
    // information_schema fallback must never be picked for a modern MariaDB.
    expect(lockWaitsSource('mariadb', '10.6.7-MariaDB')).toBe('data_lock_waits');
  });
});

describe('buildLockWaitsSql', () => {
  it('joins data_lock_waits through data_locks and INNODB_TRX on MySQL 8', () => {
    const sql = buildLockWaitsSql('data_lock_waits');
    expect(sql).toContain('FROM performance_schema.data_lock_waits');
    expect(sql).toContain('performance_schema.data_locks');
    expect(sql).toContain('information_schema.INNODB_TRX');
    expect(sql).toContain('REQUESTING_ENGINE_LOCK_ID');
    expect(sql).toContain('BLOCKING_ENGINE_TRANSACTION_ID');
    expect(sql).toContain('trx_mysql_thread_id');
    expect(sql).toContain('trx_wait_started');
    // The old plugin tables have no business in this query.
    expect(sql).not.toContain('INNODB_LOCK_WAITS');
  });

  it('joins INNODB_LOCK_WAITS through INNODB_LOCKS on the legacy path', () => {
    const sql = buildLockWaitsSql('innodb_lock_waits');
    expect(sql).toContain('FROM information_schema.INNODB_LOCK_WAITS');
    expect(sql).toContain('information_schema.INNODB_LOCKS');
    expect(sql).toContain('information_schema.INNODB_TRX');
    expect(sql).toContain('REQUESTED_LOCK_ID');
    expect(sql).toContain('trx_wait_started');
    expect(sql).not.toContain('performance_schema.data_lock_waits');
  });

  it('stays a bounded, static read-only statement on both paths', () => {
    for (const source of ['data_lock_waits', 'innodb_lock_waits'] as const) {
      const sql = buildLockWaitsSql(source);
      expect(sql).toContain('ORDER BY wait_seconds DESC');
      expect(sql).toContain('LIMIT 50');
      expect(sql).not.toContain('?');
      expect(sql.toLowerCase()).not.toMatch(/\b(insert|update|delete|drop)\b/);
    }
  });
});

describe('shapeLockWaitRow', () => {
  it('maps a MySQL 8 data_lock_waits row', () => {
    const wait = shapeLockWaitRow(
      row({
        waiter_trx_id: 4210,
        waiter_thread: 15,
        waiter_query: 'SELECT * FROM orders WHERE id = 42 FOR UPDATE',
        blocker_trx_id: 4207,
        blocker_thread: 12,
        blocker_query: null,
        wait_seconds: 23,
        lock_type: 'RECORD',
        lock_mode: 'X,REC_NOT_GAP',
        locked_table: 'shop.orders',
        locked_index: 'PRIMARY',
        held_lock_mode: 'X',
      }),
    );
    expect(wait).toEqual({
      waiterTrxId: '4210',
      waiterQuery: 'SELECT * FROM orders WHERE id = 42 FOR UPDATE',
      waiterThread: 15,
      blockerTrxId: '4207',
      blockerQuery: null,
      blockerThread: 12,
      waitSeconds: 23,
      lockType: 'RECORD',
      lockMode: 'X,REC_NOT_GAP',
      lockedTable: 'shop.orders',
      lockedIndex: 'PRIMARY',
      heldLockMode: 'X',
    });
  });

  it('maps a legacy MariaDB row with quoted table names and string counters', () => {
    const wait = shapeLockWaitRow(
      row({
        waiter_trx_id: '3915',
        waiter_thread: '4',
        waiter_query: 'UPDATE orders SET status = ?',
        blocker_trx_id: '3901',
        blocker_thread: '9',
        blocker_query: null,
        wait_seconds: '7',
        lock_type: 'RECORD',
        lock_mode: 'S',
        locked_table: '`shop`.`orders`',
        locked_index: 'idx_status',
      }),
    );
    expect(wait.waiterTrxId).toBe('3915');
    expect(wait.waiterThread).toBe(4);
    expect(wait.waitSeconds).toBe(7);
    expect(wait.lockedTable).toBe('`shop`.`orders`');
    // The column was not selected, so it degrades to null rather than crashing.
    expect(wait.heldLockMode).toBeNull();
    expect(wait.blockerQuery).toBeNull();
  });

  it('keeps missing columns null instead of fabricating values', () => {
    const wait = shapeLockWaitRow(
      row({
        waiter_trx_id: null,
        waiter_thread: null,
        waiter_query: null,
        blocker_trx_id: '42',
        blocker_thread: null,
        blocker_query: null,
        wait_seconds: null,
        lock_type: null,
        lock_mode: null,
        locked_table: null,
        locked_index: null,
        held_lock_mode: null,
      }),
    );
    expect(wait.waiterTrxId).toBe('');
    expect(wait.waiterThread).toBeNull();
    expect(wait.waitSeconds).toBe(0);
    expect(wait.lockedTable).toBeNull();
    expect(wait.blockerTrxId).toBe('42');
  });
});
