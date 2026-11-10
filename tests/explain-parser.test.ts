import { describe, expect, it } from 'vitest';

import {
  explainFindings,
  mergeAnalyzeRuntime,
  parseExplainAnalyzeTree,
} from '../server/db/explain';
import type { ExplainNode, Finding } from '../shared/types';

/**
 * A MySQL 8 `EXPLAIN ANALYZE` tree of a three-level join: every node carries
 * an estimate group and an actual group, the inner operators loop and the
 * Filter has no estimate group of its own.
 */
const JOIN_TREE = [
  '-> Nested loop inner join  (cost=105.50 rows=200) (actual time=0.15..12.55 rows=600 loops=1)',
  '    -> Table scan on orders  (cost=25.25 rows=100) (actual time=0.05..1.10 rows=100 loops=1)',
  '    -> Filter: (order_items.order_id = orders.id)  (actual time=0.02..0.09 rows=6 loops=100)',
  '        -> Index lookup on order_items using idx_order  (cost=0.40 rows=6) (actual time=0.01..0.06 rows=6 loops=100)',
].join('\n');

const findingsFor = (nodes: ExplainNode[]): Finding[] =>
  explainFindings(nodes).filter((finding) => finding.source === 'explain');

describe('parseExplainAnalyzeTree', () => {
  it('parses a multi-level join tree with estimates, costs and actual times', () => {
    const [root] = parseExplainAnalyzeTree(JOIN_TREE);

    expect(root.label).toBe('Nested loop inner join');
    expect(root.table).toBeNull();
    expect(root.rows).toBe(200);
    expect(root.cost).toBeCloseTo(105.5);
    expect(root.runtimeMs).toBeCloseTo(12.55);
    expect(root.runtimeRows).toBe(600);
    expect(root.runtimeLoops).toBe(1);

    const [scan, filter] = root.children;
    expect(scan.label).toBe('Table scan on orders');
    expect(scan.table).toBe('orders');
    expect(scan.accessType).toBe('ALL');
    expect(scan.rows).toBe(100);
    expect(scan.runtimeMs).toBeCloseTo(1.1);
    expect(scan.runtimeRows).toBe(100);

    // The Filter keeps its condition in the label and has no estimate group.
    expect(filter.label).toBe('Filter: (order_items.order_id = orders.id)');
    expect(filter.rows).toBeNull();
    expect(filter.cost).toBeNull();
    expect(filter.runtimeLoops).toBe(100);
    // `rows` is the per-loop average, so the total across 100 loops is 600.
    expect(filter.runtimeRows).toBe(600);
    expect(filter.runtimeMs).toBeCloseTo(0.09);

    const [lookup] = filter.children;
    expect(lookup.label).toBe('Index lookup on order_items using idx_order');
    expect(lookup.table).toBe('order_items');
    expect(lookup.key).toBe('idx_order');
    expect(lookup.accessType).toBe('ref');
    expect(lookup.rows).toBe(6);
    expect(lookup.cost).toBeCloseTo(0.4);
    expect(lookup.runtimeRows).toBe(600);
    expect(lookup.runtimeLoops).toBe(100);
  });

  it('parses the bracketed and single-value actual time forms', () => {
    const text = [
      '-> Sort: t1.a  (actual time=[0.10..0.20 rows=5 loops=1])',
      '    -> Table scan on t1  (cost=0.75 rows=5) (actual time=0.01 rows=5 loops=1)',
    ].join('\n');
    const [root] = parseExplainAnalyzeTree(text);
    expect(root.runtimeMs).toBeCloseTo(0.2);
    expect(root.runtimeRows).toBe(5);
    expect(root.children[0].runtimeMs).toBeCloseTo(0.01);
  });

  it('parses a node without an actual group with null runtimes', () => {
    const [root] = parseExplainAnalyzeTree('-> Limit: 10 row(s)  (cost=1.10 rows=10)');
    expect(root.label).toBe('Limit: 10 row(s)');
    expect(root.rows).toBe(10);
    expect(root.runtimeMs).toBeNull();
    expect(root.runtimeRows).toBeNull();
    expect(root.runtimeLoops).toBeNull();
  });

  it('parses the `Rows fetched before initialization` root node', () => {
    const text = [
      '-> Rows fetched before initialization  (cost=0.00..0.00 rows=1) (actual time=0.000..0.000 rows=1 loops=1)',
      '    -> Table scan on empty_table  (cost=0.00 rows=0) (actual time=0.001..0.001 rows=0 loops=1)',
    ].join('\n');
    const [root] = parseExplainAnalyzeTree(text);
    expect(root.label).toBe('Rows fetched before initialization');
    expect(root.table).toBeNull();
    expect(root.runtimeRows).toBe(1);
    // The total of a `cost=a..b` range is the second number.
    expect(root.cost).toBeCloseTo(0);
    expect(root.children[0].table).toBe('empty_table');
  });

  it('skips lines that are not tree nodes instead of failing', () => {
    const text = ['some client notice', '', ...JOIN_TREE.split('\n')].join('\n');
    const [root] = parseExplainAnalyzeTree(text);
    expect(root.children).toHaveLength(2);
  });
});

describe('mergeAnalyzeRuntime', () => {
  it('copies the tree runtimes onto the JSON plan nodes', () => {
    const [jsonRoot] = parseExplainAnalyzeTree(JOIN_TREE);
    // Strip the runtimes to model the EXPLAIN FORMAT=JSON nodes, which only
    // carry the estimates.
    const strip = (node: ExplainNode): ExplainNode => ({
      ...node,
      runtimeMs: null,
      runtimeRows: null,
      runtimeLoops: null,
      children: node.children.map(strip),
    });
    const jsonNodes = [strip(jsonRoot)];

    mergeAnalyzeRuntime(jsonNodes, parseExplainAnalyzeTree(JOIN_TREE));

    const [mergedRoot] = jsonNodes;
    // Operators without a table (the join, the filter) cannot be matched by
    // table - the same reason the findings themselves only inspect nodes with
    // a table. MySQL folds a filter into the inner table node of the JSON
    // plan (`attached_condition`), so nothing is lost there.
    expect(mergedRoot.runtimeMs).toBeNull();
    expect(mergedRoot.rows).toBe(200);
    const [mergedScan, mergedFilter] = mergedRoot.children;
    expect(mergedScan.runtimeMs).toBeCloseTo(1.1);
    expect(mergedScan.runtimeRows).toBe(100);
    expect(mergedFilter.runtimeMs).toBeNull();
    // The index lookup below the filter does merge.
    const [mergedLookup] = mergedFilter.children;
    expect(mergedLookup.table).toBe('order_items');
    expect(mergedLookup.runtimeRows).toBe(600);
    expect(mergedLookup.runtimeLoops).toBe(100);
  });

  it('matches two occurrences of the same table in plan order', () => {
    const tree = parseExplainAnalyzeTree(
      [
        '-> Nested loop inner join  (actual time=0.1..0.5 rows=2 loops=1)',
        '    -> Table scan on t  (actual time=0.01..0.02 rows=2 loops=1)',
        '    -> Table scan on t  (actual time=0.01..0.03 rows=3 loops=1)',
      ].join('\n'),
    );
    const jsonNodes: ExplainNode[] = [
      {
        id: 'a',
        label: 't',
        table: 't',
        accessType: 'ALL',
        key: null,
        possibleKeys: [],
        rows: 2,
        filtered: null,
        cost: null,
        extra: [],
        children: [
          {
            id: 'b',
            label: 't',
            table: 't',
            accessType: 'ALL',
            key: null,
            possibleKeys: [],
            rows: 2,
            filtered: null,
            cost: null,
            extra: [],
            children: [],
          },
        ],
      },
    ];
    mergeAnalyzeRuntime(jsonNodes, tree);
    expect(jsonNodes[0].runtimeMs).toBeCloseTo(0.02);
    expect(jsonNodes[0].children[0].runtimeMs).toBeCloseTo(0.03);
  });
});

describe('explain findings on an analyzed MySQL tree', () => {
  it('populates the slow-node and slow-runtime findings that need runtimes', () => {
    const nodes = parseExplainAnalyzeTree(
      [
        '-> Table scan on big_table  (cost=100.00 rows=2000) (actual time=0.10..2500.00 rows=20000 loops=1)',
      ].join('\n'),
    );
    const ruleIds = findingsFor(nodes).map((finding) => finding.ruleId);
    expect(ruleIds).toContain('explain.slow-node');
    expect(ruleIds).toContain('explain.slow-runtime');
  });

  it('reports a row estimate far below the actual rows', () => {
    const nodes = parseExplainAnalyzeTree(
      [
        '-> Table scan on big_table  (cost=5.00 rows=50) (actual time=0.10..10.00 rows=60000 loops=1)',
      ].join('\n'),
    );
    const drift = findingsFor(nodes).find(
      (finding) => finding.ruleId === 'explain.rows-estimate-drift',
    );
    expect(drift).toBeDefined();
    expect(drift!.severity).toBe('medium');
    expect(drift!.message).toContain('estimated 50 rows');
    expect(drift!.message).toContain('60,000');
    expect(drift!.recommendation).toContain('ANALYZE TABLE');
    expect(drift!.recommendation).toContain('HISTOGRAM');
  });

  it('reports the over-estimate direction at low severity', () => {
    const nodes = parseExplainAnalyzeTree(
      [
        '-> Table scan on small_table  (cost=5000.00 rows=500000) (actual time=0.10..0.20 rows=600 loops=1)',
      ].join('\n'),
    );
    const drift = findingsFor(nodes).find(
      (finding) => finding.ruleId === 'explain.rows-estimate-drift',
    );
    expect(drift).toBeDefined();
    expect(drift!.severity).toBe('low');
  });

  it('does not report drift below the minimum actual row count', () => {
    const nodes = parseExplainAnalyzeTree(
      [
        '-> Table scan on tiny_table  (cost=0.10 rows=1) (actual time=0.01..0.01 rows=400 loops=1)',
      ].join('\n'),
    );
    expect(findingsFor(nodes).map((finding) => finding.ruleId)).not.toContain(
      'explain.rows-estimate-drift',
    );
  });

  it('does not report drift when the estimate matches the per-loop actual rows', () => {
    // The Index lookup reads 6 rows per loop over 100 loops; the per-loop
    // actual equals the estimate, so the loop total must not trigger drift.
    const nodes = parseExplainAnalyzeTree(JOIN_TREE);
    expect(findingsFor(nodes).map((finding) => finding.ruleId)).not.toContain(
      'explain.rows-estimate-drift',
    );
  });
});
