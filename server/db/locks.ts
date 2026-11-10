import type { RowDataPacket } from 'mysql2/promise';
import type { LockWaitInfo, LockWaitsSnapshot, SqlFlavor } from '../../shared/types';
import { getCachedServerInfo, connectProfile, withConnection } from './manager';
import { atLeastVersion } from './metrics';

export interface Row extends RowDataPacket {
  [key: string]: unknown;
}

function str(value: unknown): string {
  return value == null ? '' : String(value);
}

function num(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export type LockWaitsSource = 'data_lock_waits' | 'innodb_lock_waits';

/**
 * Where the lock-wait graph lives. `performance_schema.data_lock_waits`
 * replaced the deprecated information_schema plugin tables on MySQL 8, and
 * MariaDB ported it in 10.5 (its own INNODB_LOCKS / INNODB_LOCK_WAITS were
 * removed in 10.6). Everything older — MySQL 5.7, MariaDB up to 10.4 — still
 * answers from information_schema.
 */
export function lockWaitsSource(flavor: SqlFlavor, version: string): LockWaitsSource {
  const modern =
    flavor === 'mariadb' ? atLeastVersion(version, 10, 5, 0) : atLeastVersion(version, 8, 0, 0);
  return modern ? 'data_lock_waits' : 'innodb_lock_waits';
}

/**
 * The lock-wait SELECT per source. `trx_id` is a VARCHAR while the engine
 * transaction ids on the wait tables are BIGINT, so COALESCE against the
 * engine id keeps a row whose transaction row vanished mid-query identifying
 * itself. The wait age is computed from `trx_wait_started`, which INNODB_TRX
 * reports on both flavors, rather than the two incompatible WAIT_AGE columns.
 */
export function buildLockWaitsSql(source: LockWaitsSource): string {
  if (source === 'data_lock_waits') {
    return `SELECT
      COALESCE(waiting_trx.trx_id, dlw.REQUESTING_ENGINE_TRANSACTION_ID) AS waiter_trx_id,
      waiting_trx.trx_mysql_thread_id                                    AS waiter_thread,
      waiting_trx.trx_query                                              AS waiter_query,
      COALESCE(blocking_trx.trx_id, dlw.BLOCKING_ENGINE_TRANSACTION_ID)  AS blocker_trx_id,
      blocking_trx.trx_mysql_thread_id                                   AS blocker_thread,
      blocking_trx.trx_query                                             AS blocker_query,
      TIMESTAMPDIFF(SECOND, waiting_trx.trx_wait_started, NOW())         AS wait_seconds,
      requested_lock.LOCK_TYPE                                           AS lock_type,
      requested_lock.LOCK_MODE                                           AS lock_mode,
      CONCAT(requested_lock.OBJECT_SCHEMA, '.', requested_lock.OBJECT_NAME) AS locked_table,
      requested_lock.INDEX_NAME                                          AS locked_index,
      blocking_lock.LOCK_MODE                                            AS held_lock_mode
    FROM performance_schema.data_lock_waits dlw
    JOIN performance_schema.data_locks requested_lock
      ON requested_lock.ENGINE_LOCK_ID = dlw.REQUESTING_ENGINE_LOCK_ID
    LEFT JOIN performance_schema.data_locks blocking_lock
      ON blocking_lock.ENGINE_LOCK_ID = dlw.BLOCKING_ENGINE_LOCK_ID
    LEFT JOIN information_schema.INNODB_TRX waiting_trx
      ON waiting_trx.trx_id = dlw.REQUESTING_ENGINE_TRANSACTION_ID
    LEFT JOIN information_schema.INNODB_TRX blocking_trx
      ON blocking_trx.trx_id = dlw.BLOCKING_ENGINE_TRANSACTION_ID
    ORDER BY wait_seconds DESC
    LIMIT 50`;
  }
  return `SELECT
    COALESCE(waiting_trx.trx_id, waits.REQUESTING_TRX_ID)       AS waiter_trx_id,
    waiting_trx.trx_mysql_thread_id                             AS waiter_thread,
    waiting_trx.trx_query                                       AS waiter_query,
    COALESCE(blocking_trx.trx_id, waits.BLOCKING_TRX_ID)        AS blocker_trx_id,
    blocking_trx.trx_mysql_thread_id                            AS blocker_thread,
    blocking_trx.trx_query                                      AS blocker_query,
    TIMESTAMPDIFF(SECOND, waiting_trx.trx_wait_started, NOW())  AS wait_seconds,
    requested_lock.LOCK_TYPE                                    AS lock_type,
    requested_lock.LOCK_MODE                                    AS lock_mode,
    requested_lock.LOCK_TABLE                                   AS locked_table,
    requested_lock.LOCK_INDEX                                   AS locked_index,
    blocking_lock.LOCK_MODE                                     AS held_lock_mode
  FROM information_schema.INNODB_LOCK_WAITS waits
  JOIN information_schema.INNODB_LOCKS requested_lock
    ON requested_lock.LOCK_ID = waits.REQUESTED_LOCK_ID
  LEFT JOIN information_schema.INNODB_LOCKS blocking_lock
    ON blocking_lock.LOCK_ID = waits.BLOCKING_LOCK_ID
  LEFT JOIN information_schema.INNODB_TRX waiting_trx
    ON waiting_trx.trx_id = waits.REQUESTING_TRX_ID
  LEFT JOIN information_schema.INNODB_TRX blocking_trx
    ON blocking_trx.trx_id = waits.BLOCKING_TRX_ID
  ORDER BY wait_seconds DESC
  LIMIT 50`;
}

/** Map one raw wait row to `LockWaitInfo`, tolerating missing columns and nulls. */
export function shapeLockWaitRow(row: Row): LockWaitInfo {
  return {
    waiterTrxId: str(row.waiter_trx_id),
    waiterQuery: row.waiter_query == null ? null : str(row.waiter_query).slice(0, 4_000),
    waiterThread: row.waiter_thread == null ? null : num(row.waiter_thread),
    blockerTrxId: str(row.blocker_trx_id),
    blockerQuery: row.blocker_query == null ? null : str(row.blocker_query).slice(0, 4_000),
    blockerThread: row.blocker_thread == null ? null : num(row.blocker_thread),
    waitSeconds: num(row.wait_seconds),
    lockType: row.lock_type == null ? null : str(row.lock_type),
    lockMode: row.lock_mode == null ? null : str(row.lock_mode),
    lockedTable: row.locked_table == null ? null : str(row.locked_table),
    lockedIndex: row.locked_index == null ? null : str(row.locked_index),
    heldLockMode: row.held_lock_mode == null ? null : str(row.held_lock_mode),
  };
}

const LOCK_WAITS_NEED_SCHEMA =
  'performance_schema is disabled on this server, so the lock-wait view is unavailable. ' +
  'Restart the server with performance_schema=ON to enable it.';

/**
 * Current lock waits as waiter → blocker edges. Read-only, and degrading like
 * the slow-query digests: an unavailable source (performance_schema off,
 * missing privileges on the source tables) returns an empty list plus a
 * reason instead of surfacing an error.
 */
export async function getLockWaits(profileId: string): Promise<LockWaitsSnapshot> {
  const server = getCachedServerInfo(profileId) ?? (await connectProfile(profileId));
  const source = lockWaitsSource(server.flavor, server.version);
  if (source === 'data_lock_waits' && !server.capabilities.performanceSchema) {
    return { waits: [], reason: LOCK_WAITS_NEED_SCHEMA };
  }
  try {
    const rows = await withConnection(profileId, async (conn) => {
      const [result] = await conn.query<Row[]>(buildLockWaitsSql(source));
      return result;
    });
    return { waits: rows.map(shapeLockWaitRow), reason: null };
  } catch (error) {
    return { waits: [], reason: `Lock waits could not be read: ${(error as Error).message}` };
  }
}
