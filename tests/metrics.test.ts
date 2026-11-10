import { describe, expect, it } from 'vitest';
import {
  atLeastVersion,
  buildDigestQuery,
  buildTableIoQuery,
  computeDeltaQps,
  computeMetrics,
  digestQuantileColumnsAvailable,
  digestScanColumnsAvailable,
  parseSlowLogText,
  shapeDigestRow,
  shapeTableIoRows,
  type Row,
} from '../server/db/metrics';

/**
 * mysql2 rows carry a nominal constructor marker; fixtures are plain objects,
 * so each one goes through this cast.
 */
function row(value: Record<string, unknown>): Row {
  return value as Row;
}

describe('delta-based QPS', () => {
  it('returns zero for the first sample', () => {
    expect(computeDeltaQps(null, { questions: 1_000, at: 10_000 })).toBe(0);
  });

  it('divides the question delta by the elapsed seconds', () => {
    expect(
      computeDeltaQps({ questions: 1_000, at: 10_000 }, { questions: 1_250, at: 15_000 }),
    ).toBe(50);
  });

  it('clamps a counter reset to zero', () => {
    expect(computeDeltaQps({ questions: 5_000, at: 10_000 }, { questions: 10, at: 15_000 })).toBe(
      0,
    );
  });

  it('returns zero when the clock does not advance', () => {
    expect(
      computeDeltaQps({ questions: 1_000, at: 10_000 }, { questions: 1_200, at: 10_000 }),
    ).toBe(0);
  });

  it('returns zero when no questions were executed', () => {
    expect(
      computeDeltaQps({ questions: 1_000, at: 10_000 }, { questions: 1_000, at: 15_000 }),
    ).toBe(0);
  });
});

describe('computeMetrics QPS sampling', () => {
  it('tracks a previous sample per profile', () => {
    const status = { Uptime: '500', Questions: '5000', Threads_connected: '3' };

    const first = computeMetrics(status, 'profile-qps-a', 1_000);
    expect(first.qps).toBe(0);
    expect(first.queries).toBe(5000);

    const second = computeMetrics({ ...status, Questions: '6000' }, 'profile-qps-a', 3_000);
    expect(second.qps).toBe(500);

    // A different profile starts over at zero.
    const other = computeMetrics(status, 'profile-qps-b', 3_000);
    expect(other.qps).toBe(0);
  });

  it('keeps the snapshot shape and reports zero without a profile', () => {
    const metrics = computeMetrics({ Uptime: '100', Questions: '900' });
    expect(metrics.qps).toBe(0);
    expect(metrics.uptimeSeconds).toBe(100);
    expect(metrics).toHaveProperty('bufferPoolHitRatio');
  });
});

/**
 * A MariaDB-style tail: the second entry repeats the first entry's second, so
 * MariaDB prints no `# Time:` line for it, and the third entry carries neither
 * `# Time:` nor `SET timestamp`.
 */
const MARIADB_TAIL = [
  '/usr/sbin/mariadbd, Version: 11.4.5-MariaDB, started with:',
  'Tcp Port: 3306, Unix Socket: /run/mysqld/mysqld.sock',
  'Time                 Id Command    Argument',
  '# Time: 241101 10:00:01',
  '# User@Host: root[root] @ localhost [127.0.0.1]',
  '# Thread_id: 10  Schema: mydb  QC_hit: No',
  '# Query_time: 1.5  Lock_time: 0.0  Rows_sent: 1  Rows_examined: 1000',
  'use mydb;',
  'SELECT * FROM big WHERE a = 1;',
  '# User@Host: root[root] @ localhost [127.0.0.1]',
  '# Thread_id: 11  Schema: mydb  QC_hit: No',
  '# Query_time: 2.5  Lock_time: 0.0  Rows_sent: 0  Rows_examined: 2000',
  'SET timestamp=1730440801;',
  'SELECT * FROM big WHERE b = 2;',
  '# User@Host: root[root] @ localhost [127.0.0.1]',
  '# Thread_id: 12  Schema: mydb  QC_hit: No',
  '# Query_time: 0.5  Lock_time: 0.0  Rows_sent: 1  Rows_examined: 10',
  'SELECT * FROM big WHERE a = 1;',
].join('\n');

describe('parseSlowLogText', () => {
  it('splits entries on User@Host, keeping same-second queries apart', () => {
    const rows = parseSlowLogText(MARIADB_TAIL);
    // Three entries in, three statements out: the two same-second entries
    // must not merge into one. The two `a = 1` entries share a digest, so
    // the result holds two rows.
    expect(rows).toHaveLength(2);
    const merged = rows.find((row) => row.digestText.includes('a = ?'));
    const separate = rows.find((row) => row.digestText.includes('b = ?'));
    expect(merged).toBeDefined();
    expect(separate).toBeDefined();
    expect(merged!.count).toBe(2);
    expect(separate!.count).toBe(1);
  });

  it('reads the timestamp from # Time, SET timestamp and then the last known time', () => {
    const rows = parseSlowLogText(MARIADB_TAIL);
    const merged = rows.find((row) => row.digestText.includes('a = ?'))!;
    const separate = rows.find((row) => row.digestText.includes('b = ?'))!;

    // First entry: the raw `# Time:` text.
    expect(merged.firstSeen).toBe('241101 10:00:01');
    // Second entry: MariaDB omitted `# Time:`; the `SET timestamp=N;` line
    // inside the query block supplies the time (1730440801 = 2024-11-01T06:00:01Z).
    expect(separate.firstSeen).toBe('2024-11-01T06:00:01.000Z');
    expect(separate.lastSeen).toBe('2024-11-01T06:00:01.000Z');
    // Third entry: no `# Time:` and no `SET timestamp`, so the previous
    // known time is carried forward.
    expect(merged.lastSeen).toBe('2024-11-01T06:00:01.000Z');
  });

  it('keeps the latency and rows counters per entry', () => {
    const rows = parseSlowLogText(MARIADB_TAIL);
    const merged = rows.find((row) => row.digestText.includes('a = ?'))!;
    expect(merged.maxLatencyMs).toBeCloseTo(1500);
    expect(merged.avgLatencyMs).toBeCloseTo(1000);
    expect(merged.rowsExamined).toBe(1010);
    expect(merged.rowsSent).toBe(2);
  });

  it('sorts by the slowest entry first', () => {
    const rows = parseSlowLogText(MARIADB_TAIL);
    expect(rows[0].digestText.includes('b = ?')).toBe(true);
  });

  it('keeps the MySQL-style # Time timestamps of every entry', () => {
    const rows = parseSlowLogText(
      [
        '# Time: 2024-11-01T10:00:01.123456Z',
        '# User@Host: root[root] @ localhost []  Id:    10',
        '# Query_time: 1.0  Lock_time: 0.0 Rows_sent: 0  Rows_examined: 0',
        'use mydb;',
        'SET timestamp=1730440801;',
        'SELECT * FROM other;',
      ].join('\n'),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].firstSeen).toBe('2024-11-01T10:00:01.123456Z');
    expect(rows[0].lastSeen).toBe('2024-11-01T10:00:01.123456Z');
  });

  it('drops the server-start headers before the first entry', () => {
    const rows = parseSlowLogText(MARIADB_TAIL);
    expect(rows.every((row) => row.digestText.startsWith('/usr/sbin'))).toBe(false);
  });

  it('returns no rows for a log with no statements', () => {
    expect(parseSlowLogText('/usr/sbin/mysqld, Version: 8.4.0, started with:')).toEqual([]);
  });
});

describe('atLeastVersion', () => {
  it('compares the dotted version, ignoring suffixes', () => {
    expect(atLeastVersion('5.7.40', 5, 7, 40)).toBe(true);
    expect(atLeastVersion('8.0.36-log', 8, 0, 0)).toBe(true);
    expect(atLeastVersion('11.4.5-MariaDB', 10, 5, 0)).toBe(true);
  });

  it('is false for versions below the gate', () => {
    expect(atLeastVersion('5.7.40', 8, 0, 0)).toBe(false);
    expect(atLeastVersion('8.0.18', 8, 0, 19)).toBe(false);
  });

  it('treats an unparsable version as zero', () => {
    expect(atLeastVersion('unknown', 0, 0, 0)).toBe(true);
    expect(atLeastVersion('unknown', 5, 6, 5)).toBe(false);
  });
});

describe('digest enrichment column gates', () => {
  it('offers the scan and temp table columns on MySQL 5.6.5 and up', () => {
    expect(digestScanColumnsAvailable('mysql', '5.7.40')).toBe(true);
    expect(digestScanColumnsAvailable('mysql', '8.4.2')).toBe(true);
    expect(digestScanColumnsAvailable('mysql', '5.6.5')).toBe(true);
    expect(digestScanColumnsAvailable('mysql', '5.6.4')).toBe(false);
    expect(digestScanColumnsAvailable('mysql', '5.5.62')).toBe(false);
  });

  it('offers them on MariaDB from the digest table introduction (10.1.2)', () => {
    expect(digestScanColumnsAvailable('mariadb', '10.1.2-MariaDB')).toBe(true);
    expect(digestScanColumnsAvailable('mariadb', '11.4.5-MariaDB')).toBe(true);
    expect(digestScanColumnsAvailable('mariadb', '10.1.1-MariaDB')).toBe(false);
    expect(digestScanColumnsAvailable('mariadb', '5.5.68-MariaDB')).toBe(false);
  });

  it('gates the quantile columns to MySQL 8.0.19 and up only', () => {
    expect(digestQuantileColumnsAvailable('mysql', '8.0.19')).toBe(true);
    expect(digestQuantileColumnsAvailable('mysql', '8.0.18')).toBe(false);
    expect(digestQuantileColumnsAvailable('mysql', '8.4.2')).toBe(true);
    // MariaDB never received the QUANTILE columns.
    expect(digestQuantileColumnsAvailable('mariadb', '11.4.5-MariaDB')).toBe(false);
  });
});

describe('buildDigestQuery', () => {
  it('selects only the base columns without gates', () => {
    const sql = buildDigestQuery(false, false);
    expect(sql).toContain('FROM performance_schema.events_statements_summary_by_digest');
    expect(sql).toContain('ORDER BY SUM_TIMER_WAIT DESC');
    expect(sql).toContain('LIMIT 20');
    expect(sql).not.toContain('SUM_NO_INDEX_USED');
    expect(sql).not.toContain('QUANTILE_95');
  });

  it('adds the scan and temp table columns when gated in', () => {
    const sql = buildDigestQuery(true, false);
    for (const column of [
      'SUM_NO_INDEX_USED',
      'SUM_NO_GOOD_INDEX_USED',
      'SUM_CREATED_TMP_TABLES',
      'SUM_CREATED_TMP_DISK_TABLES',
    ]) {
      expect(sql).toContain(column);
    }
    expect(sql).not.toContain('QUANTILE_95');
  });

  it('adds the quantile columns only when gated in', () => {
    expect(buildDigestQuery(false, true)).toContain('QUANTILE_95, QUANTILE_99');
    const both = buildDigestQuery(true, true);
    expect(both).toContain('SUM_NO_INDEX_USED');
    expect(both).toContain('QUANTILE_99');
  });

  it('stays a static read-only statement', () => {
    expect(buildDigestQuery(true, true)).not.toContain('?');
    expect(buildDigestQuery(true, true).toLowerCase()).not.toMatch(/\b(insert|update|delete)\b/);
  });
});

/** A MySQL 8 digest row carrying every enrichment column. */
const DIGEST_ROW_FULL = row({
  SCHEMA_NAME: 'shop',
  DIGEST: 'abc123',
  DIGEST_TEXT: 'SELECT * FROM orders WHERE customer_id = ?',
  COUNT_STAR: 12,
  SUM_TIMER_WAIT: '96000000000',
  AVG_TIMER_WAIT: '2500000000',
  MAX_TIMER_WAIT: '30000000000',
  SUM_ROWS_EXAMINED: 48000,
  SUM_ROWS_SENT: 120,
  FIRST_SEEN: '2026-11-08 10:00:00',
  LAST_SEEN: '2026-11-08 11:30:00',
  SUM_NO_INDEX_USED: 12,
  SUM_NO_GOOD_INDEX_USED: 3,
  SUM_CREATED_TMP_TABLES: 40,
  SUM_CREATED_TMP_DISK_TABLES: 2,
  // Timers are picoseconds: 5 s and 20 s.
  QUANTILE_95: '5000000000000',
  QUANTILE_99: '20000000000000',
});

describe('shapeDigestRow', () => {
  it('maps every enrichment column, converting picoseconds to ms', () => {
    const row = shapeDigestRow(DIGEST_ROW_FULL);
    expect(row.digest).toBe('abc123');
    expect(row.count).toBe(12);
    expect(row.avgLatencyMs).toBeCloseTo(2.5);
    expect(row.maxLatencyMs).toBeCloseTo(30);
    expect(row.noIndexUsed).toBe(12);
    expect(row.noGoodIndexUsed).toBe(3);
    expect(row.tmpTables).toBe(40);
    expect(row.tmpDiskTables).toBe(2);
    expect(row.quantile95Ms).toBeCloseTo(5000);
    expect(row.quantile99Ms).toBeCloseTo(20000);
  });

  it('keeps the base mapping for a legacy row without enrichment columns', () => {
    const shaped = shapeDigestRow(
      row({
        SCHEMA_NAME: null,
        DIGEST: 'def456',
        DIGEST_TEXT: 'COMMIT',
        COUNT_STAR: 1,
        AVG_TIMER_WAIT: '1000000000',
        MAX_TIMER_WAIT: '1000000000',
        SUM_ROWS_EXAMINED: 0,
        SUM_ROWS_SENT: 0,
        FIRST_SEEN: null,
        LAST_SEEN: null,
      }),
    );
    expect(shaped.schemaName).toBeNull();
    expect(shaped.firstSeen).toBeNull();
    expect(shaped.lastSeen).toBeNull();
    // Columns the gated SELECT skipped stay undefined, so the UI can tell
    // them apart from a real zero.
    expect(shaped.noIndexUsed).toBeUndefined();
    expect(shaped.quantile95Ms).toBeUndefined();
  });
});

describe('shapeTableIoRows', () => {
  it('maps schema, name, counters and converts the wait to ms', () => {
    const rows = shapeTableIoRows([
      row({
        TABLE_SCHEMA: 'shop',
        TABLE_NAME: 'orders',
        COUNT_STAR: 1000,
        COUNT_READ: 700,
        COUNT_WRITE: 300,
        SUM_TIMER_WAIT: '2000000000000',
      }),
      row({
        TABLE_SCHEMA: 'shop',
        TABLE_NAME: 'customers',
        COUNT_STAR: 5,
        COUNT_READ: 5,
        COUNT_WRITE: 0,
        SUM_TIMER_WAIT: 250000000,
      }),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      database: 'shop',
      table: 'orders',
      countStar: 1000,
      countRead: 700,
      countWrite: 300,
      totalLatencyMs: 2000,
    });
    expect(rows[1].totalLatencyMs).toBeCloseTo(0.25);
  });

  it('returns nothing for an empty summary', () => {
    expect(shapeTableIoRows([])).toEqual([]);
  });
});

describe('buildTableIoQuery', () => {
  it('reads the table I/O summary, top by total wait', () => {
    const sql = buildTableIoQuery(10);
    expect(sql).toContain('FROM performance_schema.table_io_waits_summary_by_table');
    expect(sql).toContain('ORDER BY SUM_TIMER_WAIT DESC');
    expect(sql).toContain('LIMIT 10');
  });

  it('excludes the system schemas and untouched tables', () => {
    const sql = buildTableIoQuery(10).toLowerCase();
    for (const schema of ['mysql', 'information_schema', 'performance_schema', 'sys']) {
      expect(sql).toContain(`'${schema}'`);
    }
    expect(sql).toContain('count_star > 0');
  });

  it('caps the limit to a safe static range', () => {
    expect(buildTableIoQuery(100)).toContain('LIMIT 50');
    expect(buildTableIoQuery(0)).toContain('LIMIT 1');
    expect(buildTableIoQuery(10)).not.toContain('?');
  });
});
