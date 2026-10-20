import { useMemo } from 'react';
import {
  Activity,
  AlertTriangle,
  ChevronRight,
  FileSearch,
  Timer,
  Zap,
} from 'lucide-react';
import type { ExplainNode, ExplainResult } from '@shared/types';
import { formatDuration, formatNumber } from '@/lib/format';
import { FindingCard } from './Findings';
import { Badge, Button, CopyButton, EmptyState, cn } from './ui';

function flatten(nodes: ExplainNode[], depth = 0): { node: ExplainNode; depth: number }[] {
  const out: { node: ExplainNode; depth: number }[] = [];
  for (const node of nodes) {
    out.push({ node, depth });
    out.push(...flatten(node.children, depth + 1));
  }
  return out;
}

function accessTone(access: string | null): 'danger' | 'warn' | 'mint' | 'neutral' {
  if (!access) return 'neutral';
  if (access === 'ALL') return 'danger';
  if (access === 'index' || access === 'range' || access === 'index_merge') return 'warn';
  if (['ref', 'eq_ref', 'const', 'system', 'unique_subquery'].includes(access)) return 'mint';
  return 'neutral';
}

export function ExplainPanel({
  explain,
  analyzing,
  onAnalyze,
}: {
  explain: ExplainResult | null;
  analyzing: boolean;
  onAnalyze?: () => void;
}) {
  const rows = useMemo(() => flatten(explain?.nodes ?? []), [explain]);

  if (!explain) {
    return (
      <EmptyState
        icon={<FileSearch size={22} />}
        title="No plan yet"
        copy="Run Explain to see how MySQL executes the current statement, or use Review for a combined rule + plan analysis."
      />
    );
  }

  const totalRows = rows.reduce((sum, item) => sum + (item.node.rows ?? 0), 0);
  const maxRows = Math.max(1, ...rows.map((item) => item.node.rows ?? 0));

  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="stat-grid">
        <div className="stat">
          <div className="stat-label">Plan nodes</div>
          <div className="stat-value">{rows.length}</div>
          <div className="stat-sub">{explain.analyzed ? 'analyzed' : 'estimated'}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Total cost</div>
          <div className="stat-value">{explain.totalCost != null ? explain.totalCost.toFixed(2) : '—'}</div>
          <div className="stat-sub">optimizer units</div>
        </div>
        <div className="stat">
          <div className="stat-label">Estimated rows</div>
          <div className="stat-value">{formatNumber(totalRows)}</div>
          <div className="stat-sub">sum of node estimates</div>
        </div>
        <div className="stat">
          <div className="stat-label">Plan time</div>
          <div className="stat-value">{formatDuration(explain.executionMs)}</div>
          <div className="stat-sub">EXPLAIN call</div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={explain.analyzed ? 'mint' : 'neutral'}>
          <Activity size={11} /> {explain.analyzed ? 'ANALYZE' : 'EXPLAIN'}
        </Badge>
        <Badge tone={explain.insights.length > 0 ? 'warn' : 'mint'}>
          {explain.insights.length} plan insight{explain.insights.length === 1 ? '' : 's'}
        </Badge>
        {onAnalyze && !explain.analyzed ? (
          <Button
            variant="secondary"
            size="sm"
            icon={analyzing ? <Timer size={12} className="spin" /> : <Zap size={12} />}
            onClick={onAnalyze}
            loading={analyzing}
            className="ml-auto"
          >
            Run ANALYZE (executes)
          </Button>
        ) : null}
      </div>

      {explain.insights.length > 0 ? (
        <div className="flex flex-col gap-2">
          {explain.insights.map((finding) => (
            <FindingCard key={finding.id} finding={finding} compact />
          ))}
        </div>
      ) : (
        <div className="callout mint flex items-center gap-2">
          <AlertTriangle size={14} className="text-mint" />
          No obvious plan red flags. Still check row estimates against real data.
        </div>
      )}

      <div className="overflow-x-auto rounded-xl border border-line-soft">
        <table className="data-table">
          <thead>
            <tr>
              <th>Table / node</th>
              <th>Access</th>
              <th>Key</th>
              <th>Rows</th>
              <th>Filtered</th>
              <th>Cost</th>
              <th>Extra</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ node, depth }) => {
              const ratio = (node.rows ?? 0) / maxRows;
              return (
                <tr key={node.id}>
                  <td>
                    <span style={{ paddingLeft: depth * 14 }} className="inline-flex items-center gap-1.5">
                      {depth > 0 ? <ChevronRight size={10} className="text-muted" /> : null}
                      <span className="font-semibold text-ink">{node.table ?? node.label}</span>
                    </span>
                  </td>
                  <td>
                    {node.accessType ? (
                      <Badge tone={accessTone(node.accessType)}>{node.accessType}</Badge>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="text-mint">{node.key ?? '—'}</td>
                  <td>
                    <div className="flex items-center gap-2">
                      <span className="tabular-nums">{formatNumber(node.rows)}</span>
                      <span className="h-1.5 w-14 overflow-hidden rounded-full bg-panel-3">
                        <span
                          className={cn('block h-full rounded-full', ratio > 0.6 ? 'bg-danger' : ratio > 0.25 ? 'bg-warn' : 'bg-mint')}
                          style={{ width: `${Math.max(4, ratio * 100)}%` }}
                        />
                      </span>
                    </div>
                  </td>
                  <td>{node.filtered != null ? `${node.filtered.toFixed(1)}%` : '—'}</td>
                  <td>{node.cost != null ? node.cost.toFixed(2) : '—'}</td>
                  <td className="max-w-[320px]">
                    <div className="flex flex-wrap gap-1">
                      {node.extra.map((extra, index) => (
                        <span
                          key={index}
                          className="rounded border border-line-soft bg-panel-2 px-1.5 py-0.5 text-[9px] text-muted"
                        >
                          {extra}
                        </span>
                      ))}
                      {node.runtimeRows != null ? (
                        <span className="rounded border border-info/30 bg-info/10 px-1.5 py-0.5 text-[9px] text-info">
                          runtime rows {formatNumber(node.runtimeRows)}
                        </span>
                      ) : null}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {explain.suggestions.length > 0 ? (
        <div className="flex flex-col gap-2">
          <div className="section-title">Index suggestions</div>
          {explain.suggestions.map((suggestion) => (
            <div key={suggestion.statement} className="finding sev-info p-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone="info">{suggestion.confidence} confidence</Badge>
                <span className="font-mono text-[11px] text-ink">
                  {suggestion.database}.{suggestion.table} ({suggestion.columns.join(', ')})
                </span>
              </div>
              <div className="finding-message">{suggestion.reason}</div>
              <pre className="code-block mt-2 text-[10.5px]">{suggestion.statement}</pre>
              <div className="mt-1 flex justify-end">
                <CopyButton text={suggestion.statement} label="Copy ALTER" />
              </div>
            </div>
          ))}
        </div>
      ) : null}

      <details className="rounded-xl border border-line-soft bg-panel-2/40 p-3">
        <summary className="cursor-pointer text-[11px] font-semibold text-muted">
          Raw plan {explain.analyzed ? '(ANALYZE)' : '(JSON)'}
        </summary>
        <pre className="code-block mt-2 max-h-80 text-[10.5px]">
          {typeof explain.raw === 'string'
            ? explain.raw
            : JSON.stringify(explain.raw, null, 2)}
        </pre>
        {explain.text ? (
          <pre className="code-block mt-2 max-h-80 whitespace-pre-wrap text-[10.5px]">
            {explain.text}
          </pre>
        ) : null}
      </details>
    </div>
  );
}
