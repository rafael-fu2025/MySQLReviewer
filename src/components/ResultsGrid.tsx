import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, ArrowRight, Download, Eye, EyeOff, FileJson, Lock, Rows3 } from 'lucide-react';
import type { CellValue, QueryColumn, QueryResult } from '@shared/types';
import { copyText, downloadCsv, downloadJson, formatDuration, formatNumber } from '@/lib/format';
import { useAppStore } from '@/store/app-store';
import { Badge, Button, ConfirmDialog, EmptyState } from './ui';

function cellContent(value: CellValue): { node: ReactNode; className: string; title?: string } {
  if (value === null) {
    return {
      node: <span className="italic text-muted/70">NULL</span>,
      className: 'null',
    };
  }
  if (typeof value === 'number') {
    return { node: value, className: 'num' };
  }
  if (typeof value === 'boolean') {
    return { node: String(value), className: 'text-warn' };
  }
  if (Array.isArray(value)) {
    const text = JSON.stringify(value);
    return {
      node: text.length > 160 ? `${text.slice(0, 160)}…` : text,
      className: 'text-violet',
      title: text.slice(0, 2_000),
    };
  }
  if (typeof value === 'object') {
    if ('__type' in value && (value as { __type?: string }).__type === 'binary') {
      const binary = value as {
        length: number;
        previewHex: string;
        truncated: boolean;
      };
      return {
        node: `0x${binary.previewHex}${binary.truncated ? '…' : ''}`,
        className: 'bin',
        title: `${binary.length} bytes`,
      };
    }
    const text = JSON.stringify(value);
    return {
      node: text.length > 160 ? `${text.slice(0, 160)}…` : text,
      className: 'text-violet',
      title: text.slice(0, 2_000),
    };
  }
  const text = String(value);
  return {
    node: text.length > 180 ? `${text.slice(0, 180)}…` : text,
    className: '',
    title: text.length > 180 ? text.slice(0, 2_000) : undefined,
  };
}

/**
 * One result row. Rows are memoized so a parent render (page change, toast,
 * unrelated state) never re-serializes the cells that are already on screen.
 */
const ResultRow = memo(function ResultRow({
  row,
  rowNumber,
}: {
  row: CellValue[];
  rowNumber: number;
}) {
  return (
    <tr>
      <td className="text-muted/60">{rowNumber}</td>
      {row.map((value, columnIndex) => {
        const cell = cellContent(value);
        return (
          <td key={columnIndex} className={cell.className} title={cell.title}>
            {cell.node}
          </td>
        );
      })}
    </tr>
  );
});

/**
 * What a result set was: how many rows came back, and how long the
 * statement took.
 *
 * The grid shows it once, in its own toolbar.
 */
export function ResultsSummary({
  rowCount,
  executionMs,
}: {
  rowCount: number;
  executionMs: number;
}) {
  return (
    <span className="font-mono text-2xs text-muted">
      {formatNumber(rowCount)} rows · {formatDuration(executionMs)}
    </span>
  );
}

/**
 * The table of a result set.
 *
 * The rows are the ones on the current page; `rowOffset` is the number of
 * rows that came before them, so the row numbers keep counting.
 *
 * The table keeps its natural width and the pane scrolls in both directions:
 * laid out at the width of the pane, the browser squeezed the last column
 * until its values were cut off mid-word, and the pane showed no sign that
 * there was more to see.
 */
export function ResultsTable({
  columns,
  rows,
  rowOffset = 0,
}: {
  columns: QueryColumn[];
  rows: CellValue[][];
  rowOffset?: number;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-x-auto overflow-y-auto">
      <table className="data-table min-w-max">
        <thead>
          <tr>
            <th style={{ width: 46 }}>#</th>
            {columns.map((column, index) => (
              <th key={`${column.name}-${index}`} title={`${column.table ?? ''} ${column.name}`}>
                <span className="inline-flex items-center gap-1">
                  {column.sensitive ? <Lock size={9} className="text-warn" /> : null}
                  {column.name}
                </span>
                <span className="col-type">{column.typeName}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <ResultRow key={rowOffset + rowIndex} row={row} rowNumber={rowOffset + rowIndex + 1} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ResultsGridBase({ result, onReveal }: { result: QueryResult; onReveal?: () => void }) {
  const toast = useAppStore((state) => state.toast);
  const currentUser = useAppStore((state) => state.currentUser);
  const [page, setPage] = useState(0);
  const [revealOpen, setRevealOpen] = useState(false);
  const pageSize = 100;

  // A new result always starts on the first page. Adjusting the state while
  // rendering keeps the grid from briefly showing the previous page of the
  // new result and avoids the extra render pass an effect would cause.
  const [lastResult, setLastResult] = useState(result);
  if (result !== lastResult) {
    setLastResult(result);
    setPage(0);
  }

  // The grid is memoized on `result` alone; keep the callback fresh via a ref.
  const onRevealRef = useRef(onReveal);
  useEffect(() => {
    onRevealRef.current = onReveal;
  });

  const totalPages = Math.max(1, Math.ceil(result.rows.length / pageSize));
  const rows = useMemo(
    () => result.rows.slice(page * pageSize, page * pageSize + pageSize),
    [page, result.rows],
  );

  const isMutation = result.columns.length === 0;

  const exportCsv = (): void => {
    downloadCsv('mylens-query-result.csv', result.columns, result.rows);
  };
  const exportJson = (): void => {
    downloadJson('mylens-query-result.json', {
      sql: result.sql,
      columns: result.columns,
      rows: result.rows,
      rowCount: result.rowCount,
      executionMs: result.executionMs,
      truncated: result.truncated,
    });
  };

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-line-soft px-3 py-2">
        <ResultsSummary rowCount={result.rowCount} executionMs={result.executionMs} />
        {result.unlocked && currentUser?.role !== 'admin' ? (
          <Badge tone="warn">unlocked</Badge>
        ) : null}
        {result.warnings.length > 0 ? (
          <Badge tone="warn">{result.warnings.length} warnings</Badge>
        ) : null}
        {result.masked ? (
          <Badge tone="warn">
            <EyeOff size={10} /> sensitive values masked
          </Badge>
        ) : result.columns.some((column) => column.sensitive) ? (
          <Badge tone="danger">
            <Eye size={10} /> sensitive values visible
          </Badge>
        ) : null}
        <div className="ml-auto flex items-center gap-1">
          {result.masked && onReveal ? (
            <Button
              variant="ghost"
              size="sm"
              icon={<Eye size={12} />}
              onClick={() => setRevealOpen(true)}
            >
              Reveal
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            icon={<Download size={12} />}
            onClick={exportCsv}
            disabled={result.columns.length === 0}
          >
            CSV
          </Button>
          <Button
            variant="ghost"
            size="sm"
            icon={<FileJson size={12} />}
            onClick={exportJson}
            disabled={result.columns.length === 0}
          >
            JSON
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={async () => {
              const text = JSON.stringify(
                { columns: result.columns.map((column) => column.name), rows: result.rows },
                null,
                2,
              );
              const ok = await copyText(text);
              toast(
                ok ? 'Result copied to clipboard.' : 'Could not copy the result.',
                ok ? 'success' : 'error',
              );
            }}
          >
            Copy
          </Button>
        </div>
      </div>

      {result.truncated ? (
        <div className="border-b border-warn/20 bg-warn/5 px-3 py-2 text-2xs text-warn">
          Result capped at {formatNumber(result.rowCount)} rows — adjust the cap in Settings.
        </div>
      ) : null}

      {isMutation ? (
        <div className="flex flex-1 items-center justify-center p-8">
          <div className="max-w-md text-center">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl border border-mint/25 bg-mint/10 text-mint">
              <Rows3 size={20} />
            </div>
            <div className="mt-3 text-md font-bold">Statement completed</div>
            <div className="mt-1 text-xs text-muted">{result.info || 'No rows returned.'}</div>
            <div className="mt-4 grid grid-cols-2 gap-2 text-left">
              <div className="stat">
                <div className="stat-label">Affected rows</div>
                <div className="stat-value">{formatNumber(result.affectedRows)}</div>
              </div>
              <div className="stat">
                <div className="stat-label">Insert ID</div>
                <div className="stat-value text-base">{result.insertId ?? '—'}</div>
              </div>
            </div>
            <div className="mt-3 font-mono text-2xs text-muted">
              {result.kind} · {formatDuration(result.executionMs)}
            </div>
          </div>
        </div>
      ) : result.rows.length === 0 ? (
        <EmptyState icon={<Rows3 size={22} />} title="No rows returned" />
      ) : (
        <ResultsTable columns={result.columns} rows={rows} rowOffset={page * pageSize} />
      )}

      {totalPages > 1 ? (
        <div className="flex items-center justify-between gap-2 border-t border-line-soft px-3 py-2 text-2xs text-muted">
          <span>
            Page {page + 1} of {totalPages} · showing {page * pageSize + 1}–
            {Math.min(result.rows.length, (page + 1) * pageSize)} of {result.rows.length}
          </span>
          <div className="flex gap-1">
            <Button
              variant="ghost"
              size="sm"
              icon={<ArrowLeft size={12} />}
              disabled={page === 0}
              onClick={() => setPage((value) => Math.max(0, value - 1))}
            >
              Prev
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={page >= totalPages - 1}
              onClick={() => setPage((value) => Math.min(totalPages - 1, value + 1))}
            >
              Next <ArrowRight size={12} />
            </Button>
          </div>
        </div>
      ) : null}

      <ConfirmDialog
        open={revealOpen}
        onClose={() => setRevealOpen(false)}
        onConfirm={() => {
          setRevealOpen(false);
          onRevealRef.current?.();
        }}
        title="Reveal sensitive values?"
        message="Re-runs the statement with sensitive columns unmasked. The result may contain credentials or personal data."
        confirmLabel="Reveal values"
        danger
      />
    </div>
  );
}

/**
 * Only a new result (or the arrival/removal of a reveal handler) can change
 * what the grid renders, so compare those and ignore callback identity churn.
 */
export const ResultsGrid = memo(
  ResultsGridBase,
  (previous, next) =>
    previous.result === next.result && Boolean(previous.onReveal) === Boolean(next.onReveal),
);
