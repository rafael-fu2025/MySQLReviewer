import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { LockWaitsPanel, SlowSignalBadges, TableIoSection } from '../src/pages/PerformancePage';
import type { SlowQueryInfo, TableIoInfo } from '../shared/types';

/**
 * The performance page's diagnostics sections, rendered as presentational
 * components with plain props (the page itself reads the app store and the
 * router, so only the parts are under test here).
 */

/** The visible text of a markup fragment, without the tags. */
function textOf(html: string): string {
  return html.replace(/<[^>]*>/g, '');
}

const enrichedQuery: SlowQueryInfo = {
  digest: 'd1',
  digestText: 'SELECT * FROM orders WHERE customer_id = ?',
  schemaName: 'shop',
  count: 12,
  avgLatencyMs: 2.5,
  maxLatencyMs: 30,
  rowsExamined: 48000,
  rowsSent: 120,
  firstSeen: null,
  lastSeen: null,
  noIndexUsed: 12,
  noGoodIndexUsed: 3,
  tmpTables: 40,
  tmpDiskTables: 2,
  quantile95Ms: 5000,
  quantile99Ms: 20000,
};

describe('SlowSignalBadges', () => {
  it('renders every enrichment signal as a compact badge', () => {
    const text = textOf(renderToStaticMarkup(<SlowSignalBadges query={enrichedQuery} />));
    expect(text).toContain('no idx: 12');
    expect(text).toContain('no good idx: 3');
    expect(text).toContain('tmp: 40');
    expect(text).toContain('tmp disk: 2');
    expect(text).toContain('p95: 5.00 s');
    expect(text).toContain('p99: 20.00 s');
  });

  it('hides counters that are zero so a healthy row stays quiet', () => {
    const text = textOf(
      renderToStaticMarkup(
        <SlowSignalBadges query={{ ...enrichedQuery, noIndexUsed: 0, tmpTables: 0 }} />,
      ),
    );
    expect(text).not.toContain('no idx');
    expect(text).not.toContain('tmp:');
    // The index-quality signals stay, they are above zero.
    expect(text).toContain('no good idx: 3');
  });

  it('shows a dash for slow-log rows without digest enrichment', () => {
    const text = textOf(
      renderToStaticMarkup(
        <SlowSignalBadges
          query={{
            digest: 'd2',
            digestText: 'SELECT * FROM big',
            schemaName: null,
            count: 1,
            avgLatencyMs: 10,
            maxLatencyMs: 10,
            rowsExamined: 10,
            rowsSent: 1,
            firstSeen: null,
            lastSeen: null,
          }}
        />,
      ),
    );
    expect(text).toContain('—');
    expect(text).not.toContain('no idx');
    expect(text).not.toContain('p95');
  });
});

const waitRow = {
  waiterTrxId: '4210',
  waiterQuery: 'SELECT * FROM orders WHERE id = 42 FOR UPDATE',
  waiterThread: 15,
  blockerTrxId: '4207',
  blockerQuery: 'UPDATE orders SET status = ?',
  blockerThread: 12,
  waitSeconds: 45,
  lockType: 'RECORD',
  lockMode: 'X,REC_NOT_GAP',
  lockedTable: 'shop.orders',
  lockedIndex: 'PRIMARY',
  heldLockMode: 'X',
};

describe('LockWaitsPanel', () => {
  it('renders the waiter → blocker chain with lock info', () => {
    const html = renderToStaticMarkup(
      <LockWaitsPanel snapshot={{ waits: [waitRow], reason: null }} />,
    );
    const text = textOf(html);
    expect(text).toContain('Lock waits');
    expect(text).toContain('Waiting transaction');
    expect(text).toContain('Blocked by');
    expect(text).toContain('trx 4210');
    expect(text).toContain('thread 15');
    expect(text).toContain(waitRow.waiterQuery);
    expect(text).toContain('trx 4207');
    expect(text).toContain('thread 12');
    expect(text).toContain('45s');
    expect(text).toContain('X,REC_NOT_GAP');
    // The mode the blocker holds, only when it differs from the request.
    expect(text).toContain('held: X');
    expect(text).toContain('shop.orders · PRIMARY');
    expect(text).toContain('Refresh');
    expect(text).not.toContain('No lock waits');
  });

  it('keeps the empty state quiet and honest when the server has no waits', () => {
    const text = textOf(
      renderToStaticMarkup(<LockWaitsPanel snapshot={{ waits: [], reason: null }} />),
    );
    expect(text).toContain('No lock waits');
    expect(text).toContain('No transaction is currently waiting');
  });

  it('explains why the data is unavailable instead of implying there are no waits', () => {
    const text = textOf(
      renderToStaticMarkup(
        <LockWaitsPanel
          snapshot={{
            waits: [],
            reason:
              'performance_schema is disabled on this server, so the lock-wait view is unavailable.',
          }}
        />,
      ),
    );
    expect(text).toContain('No lock waits');
    expect(text).toContain('performance_schema is disabled');
  });
});

const ioRows: TableIoInfo[] = [
  {
    database: 'shop',
    table: 'orders',
    countStar: 1000,
    countRead: 700,
    countWrite: 300,
    totalLatencyMs: 2000,
  },
  {
    database: 'shop',
    table: 'customers',
    countStar: 5,
    countRead: 5,
    countWrite: 0,
    totalLatencyMs: 0.25,
  },
];

describe('TableIoSection', () => {
  it('ranks tables by activity with reads, writes and wait', () => {
    const text = textOf(renderToStaticMarkup(<TableIoSection tables={ioRows} reason={null} />));
    expect(text).toContain('I/O hotspots');
    // The section is clearly labelled as since-server-start activity.
    expect(text).toContain('activity since server start');
    expect(text).toContain('shop.orders');
    expect(text).toContain('700');
    expect(text).toContain('300');
    expect(text).toContain('2.00 s');
    expect(text).toContain('shop.customers');
  });

  it('reports the unavailability reason when performance_schema is off', () => {
    const text = textOf(
      renderToStaticMarkup(
        <TableIoSection
          tables={[]}
          reason="performance_schema is disabled on this server, so table I/O statistics are unavailable."
        />,
      ),
    );
    expect(text).toContain('performance_schema is disabled');
    expect(text).not.toContain('shop.orders');
  });

  it('falls back to its own empty copy when there is nothing and no reason', () => {
    const text = textOf(renderToStaticMarkup(<TableIoSection tables={[]} reason={null} />));
    expect(text).toContain('No table I/O recorded yet.');
  });
});
