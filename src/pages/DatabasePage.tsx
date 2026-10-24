import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  Database,
  Download,
  Eye,
  Filter,
  KeyRound,
  Link2,
  Plus,
  RefreshCw,
  Search,
  Table2,
  X,
  Zap,
} from 'lucide-react';
import type {
  ColumnInfo,
  QueryResult,
  TableDataFilter,
  TableDetail,
  TableSummary,
} from '@shared/types';
import { useAppStore } from '@/store/app-store';
import { dbApi } from '@/lib/db-api';
import { downloadText } from '@/lib/api';
import { formatBytes, formatNumber } from '@/lib/format';
import { ResultsGrid } from '@/components/ResultsGrid';
import { CreateDatabaseModal } from '@/components/CreateDatabaseModal';
import { Combobox } from '@/components/Combobox';
import {
  Badge,
  Button,
  Card,
  CopyButton,
  EmptyState,
  IconButton,
  Input,
  Modal,
  PageHeader,
  Spinner,
  StatCard,
  Tabs,
} from '@/components/ui';
import { cn } from '@/lib/utils';

function CodeBlock({ text, className }: { text: string; className?: string }) {
  return <pre className={cn('code-block', className)}>{text}</pre>;
}

function TableLink({ table, onOpen }: { table: TableSummary; onOpen: () => void }) {
  return (
    <button
      type="button"
      className="flex w-full items-center gap-3 rounded-lg border border-line-soft bg-panel-2/40 px-3 py-2 text-left transition hover:border-ember/35 hover:bg-panel-2"
      onClick={onOpen}
    >
      <Table2 size={14} className="shrink-0 text-muted" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12px] font-semibold text-ink">{table.name}</div>
        <div className="mt-0.5 font-mono text-[10px] text-muted">
          {table.engine ?? (table.type === 'BASE TABLE' ? '—' : 'view')} ·{' '}
          {formatNumber(table.rowsEstimate)} rows ·{' '}
          {formatBytes(table.dataBytes + table.indexBytes)}
        </div>
      </div>
      <ChevronRight size={13} className="text-muted" />
    </button>
  );
}

function RelationMap({
  detail,
  onOpen,
}: {
  detail: TableDetail;
  onOpen: (database: string, table: string) => void;
}) {
  const outgoing = detail.foreignKeys;
  const incoming = detail.referencedBy;
  if (outgoing.length === 0 && incoming.length === 0) {
    return <EmptyState icon={<Link2 size={22} />} title="No relationships" />;
  }

  const leftNodes = incoming.slice(0, 8);
  const rightNodes = outgoing.slice(0, 8);
  const height = Math.max(260, Math.max(leftNodes.length, rightNodes.length) * 56 + 80);
  const width = 820;
  const centerX = width / 2;
  const centerY = height / 2;

  const nodeY = (index: number, count: number): number => {
    if (count === 1) return centerY;
    return 60 + index * ((height - 120) / (count - 1));
  };

  // SVG nodes are reachable with the keyboard and behave like buttons.
  const activateNode = (event: React.KeyboardEvent<SVGGElement>, action: () => void): void => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    action();
  };

  return (
    <div className="overflow-auto rounded-xl border border-line-soft bg-panel-2/25">
      <svg width={width} height={height} role="group" aria-label="Table relationships">
        <defs>
          <marker
            id="arrow"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="5"
            markerHeight="5"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--color-muted)" />
          </marker>
        </defs>
        {leftNodes.map((fk, index) => {
          const y = nodeY(index, leftNodes.length);
          return (
            <g key={`in-${fk.name}`}>
              <line
                x1={180}
                y1={y}
                x2={centerX - 82}
                y2={centerY}
                stroke="var(--color-line)"
                strokeWidth={1.4}
                markerEnd="url(#arrow)"
              />
              <text
                x={190}
                y={y - 6}
                fill="var(--color-muted)"
                fontSize={9}
                fontFamily="var(--font-mono)"
              >
                {fk.columns.join(', ')}
              </text>
            </g>
          );
        })}
        {rightNodes.map((fk, index) => {
          const y = nodeY(index, rightNodes.length);
          return (
            <g key={`out-${fk.name}`}>
              <line
                x1={centerX + 82}
                y1={centerY}
                x2={width - 190}
                y2={y}
                stroke="var(--color-line)"
                strokeWidth={1.4}
                markerEnd="url(#arrow)"
              />
              <text
                x={centerX + 92}
                y={centerY + 14}
                fill="var(--color-muted)"
                fontSize={9}
                fontFamily="var(--font-mono)"
              >
                {fk.columns.join(', ')}
              </text>
            </g>
          );
        })}

        <g>
          <rect
            x={centerX - 82}
            y={centerY - 20}
            width={164}
            height={40}
            rx={10}
            fill="color-mix(in oklab, var(--color-ember) 16%, var(--color-panel))"
            stroke="var(--color-ember)"
          />
          <text
            x={centerX}
            y={centerY + 4}
            textAnchor="middle"
            fill="var(--color-ink)"
            fontSize={12}
            fontWeight={700}
          >
            {detail.summary.name}
          </text>
        </g>

        {leftNodes.map((fk, index) => {
          const y = nodeY(index, leftNodes.length);
          return (
            <g
              key={`in-node-${fk.name}`}
              role="button"
              tabIndex={0}
              aria-label={`Open ${fk.referencedDatabase}.${fk.referencedTable}`}
              className="cursor-pointer"
              onClick={() => onOpen(fk.referencedDatabase, fk.referencedTable)}
              onKeyDown={(event) =>
                activateNode(event, () => onOpen(fk.referencedDatabase, fk.referencedTable))
              }
            >
              <rect
                x={30}
                y={y - 18}
                width={150}
                height={36}
                rx={9}
                fill="var(--color-panel-2)"
                stroke="var(--color-line)"
              />
              <text
                x={105}
                y={y + 4}
                textAnchor="middle"
                fill="var(--color-ink-soft)"
                fontSize={11}
              >
                {fk.referencedTable}
              </text>
            </g>
          );
        })}
        {rightNodes.map((fk, index) => {
          const y = nodeY(index, rightNodes.length);
          return (
            <g
              key={`out-node-${fk.name}`}
              role="button"
              tabIndex={0}
              aria-label={`Open ${fk.referencedDatabase}.${fk.referencedTable}`}
              className="cursor-pointer"
              onClick={() => onOpen(fk.referencedDatabase, fk.referencedTable)}
              onKeyDown={(event) =>
                activateNode(event, () => onOpen(fk.referencedDatabase, fk.referencedTable))
              }
            >
              <rect
                x={width - 180}
                y={y - 18}
                width={150}
                height={36}
                rx={9}
                fill="var(--color-panel-2)"
                stroke="var(--color-line)"
              />
              <text
                x={width - 105}
                y={y + 4}
                textAnchor="middle"
                fill="var(--color-ink-soft)"
                fontSize={11}
              >
                {fk.referencedTable}
              </text>
            </g>
          );
        })}
      </svg>
      <div className="border-t border-line-soft px-3 py-2 text-[10px] text-muted">
        Left: tables referencing this table. Right: tables this table references.
      </div>
    </div>
  );
}

function DataPreview({
  profileId,
  database,
  table,
  columns,
}: {
  profileId: string;
  database: string;
  table: string;
  columns: ColumnInfo[];
}) {
  const [limit, setLimit] = useState(100);
  const [orderBy, setOrderBy] = useState('');
  const [orderDir, setOrderDir] = useState<'asc' | 'desc'>('asc');
  const [filters, setFilters] = useState<TableDataFilter[]>([]);
  const [column, setColumn] = useState(columns[0]?.name ?? '');
  const [operator, setOperator] = useState<TableDataFilter['operator']>('=');
  const [value, setValue] = useState('');
  const [result, setResult] = useState<QueryResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Only the newest request may write the grid: a slow response for table A must
  // never land after a faster response for table B.
  const requestId = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  // The request itself carries no state, so an effect can start a load without
  // setting state first. The caller decides what to do with the response.
  const request = useCallback(
    (
      nextFilters: TableDataFilter[],
      nextOrder: string,
      nextDir: 'asc' | 'desc',
      nextLimit: number,
      nextReveal: boolean,
      signal: AbortSignal,
    ): Promise<QueryResult> =>
      dbApi.tableData(
        profileId,
        database,
        table,
        {
          limit: nextLimit,
          orderBy: nextOrder || null,
          orderDir: nextDir,
          filters: nextFilters,
          revealSensitive: nextReveal,
        },
        { signal },
      ),
    [database, profileId, table],
  );

  const load = useCallback(
    async (
      nextFilters: TableDataFilter[],
      nextOrder: string,
      nextDir: 'asc' | 'desc',
      nextLimit: number,
      nextReveal = false,
    ): Promise<void> => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const id = requestId.current + 1;
      requestId.current = id;
      setLoading(true);
      setError(null);
      try {
        const data = await request(
          nextFilters,
          nextOrder,
          nextDir,
          nextLimit,
          nextReveal,
          controller.signal,
        );
        if (requestId.current !== id) return;
        setResult(data);
      } catch (err) {
        if (requestId.current !== id || controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (requestId.current === id) setLoading(false);
      }
    },
    [request],
  );

  // The preview starts from a clean slate: a different table or database
  // remounts the component (see the `key` in TableDetailView), so the reset
  // does not need an effect.
  useEffect(() => {
    const controller = new AbortController();
    abortRef.current = controller;
    const id = requestId.current + 1;
    requestId.current = id;
    request([], '', 'asc', 100, false, controller.signal)
      .then((data) => {
        if (requestId.current !== id) return;
        setResult(data);
        setLoading(false);
      })
      .catch((err) => {
        if (requestId.current !== id || controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
    return () => {
      controller.abort();
    };
  }, [request]);

  // Columns change after a schema refresh (or when another database exposes a
  // table with the same name). Never leave the filter/sort pointing at a column
  // that no longer exists. The state is adjusted while rendering so the grid
  // never points at a column that is gone.
  const columnNames = useMemo(() => columns.map((item) => item.name).join('\u0000'), [columns]);
  const [knownColumns, setKnownColumns] = useState(columnNames);
  if (knownColumns !== columnNames) {
    setKnownColumns(columnNames);
    const names = new Set(columns.map((item) => item.name));
    setColumn((previous) => (names.has(previous) ? previous : (columns[0]?.name ?? '')));
    setOrderBy((previous) => (previous && !names.has(previous) ? '' : previous));
    setFilters((previous) => {
      const next = previous.filter((filter) => names.has(filter.column));
      return next.length === previous.length ? previous : next;
    });
  }

  const addFilter = (): void => {
    if (!column) return;
    if (!['IS NULL', 'IS NOT NULL'].includes(operator) && !value) return;
    const next = [
      ...filters,
      {
        column,
        operator,
        ...(operator === 'IS NULL' || operator === 'IS NOT NULL' ? {} : { value }),
      },
    ];
    setFilters(next);
    setValue('');
    void load(next, orderBy, orderDir, limit);
  };

  const removeFilter = (index: number): void => {
    const next = filters.filter((_, i) => i !== index);
    setFilters(next);
    void load(next, orderBy, orderDir, limit);
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="card flex flex-wrap items-end gap-2 p-3">
        <div className="field min-w-[150px] flex-1">
          <span className="field-label">Filter column</span>
          <Combobox
            options={columns.map((item) => ({
              value: item.name,
              label: item.name,
              description: item.columnType,
            }))}
            value={column}
            onChange={(value) => {
              if (value) setColumn(value);
            }}
            clearable={false}
          />
        </div>
        <div className="field w-[130px]">
          <span className="field-label">Operator</span>
          <Combobox
            options={[
              '=',
              '!=',
              '>',
              '>=',
              '<',
              '<=',
              'LIKE',
              'NOT LIKE',
              'IS NULL',
              'IS NOT NULL',
            ].map((item) => ({ value: item, label: item }))}
            value={operator}
            onChange={(next) => setOperator(next as TableDataFilter['operator'])}
            clearable={false}
            maxHeight={300}
          />
        </div>
        <label className="field min-w-[150px] flex-1">
          <span className="field-label">Value</span>
          <Input
            value={value}
            onChange={(event) => setValue(event.target.value)}
            disabled={['IS NULL', 'IS NOT NULL'].includes(operator)}
            placeholder="value"
            onKeyDown={(event) => {
              if (event.key === 'Enter') addFilter();
            }}
          />
        </label>
        <Button variant="secondary" size="sm" icon={<Filter size={12} />} onClick={addFilter}>
          Add filter
        </Button>
      </div>

      {filters.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {filters.map((filter, index) => (
            <span
              key={`${filter.column}-${index}`}
              className="inline-flex items-center gap-1 rounded-full border border-info/30 bg-info/10 px-2 py-0.5 font-mono text-[10px] text-info"
            >
              {filter.column} {filter.operator} {filter.value ?? ''}
              <button type="button" onClick={() => removeFilter(index)} aria-label="Remove filter">
                <X size={10} />
              </button>
            </span>
          ))}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <div className="field w-[180px]">
          <span className="field-label">Sort by</span>
          <Combobox
            options={[
              { value: '', label: '(none)' },
              ...columns.map((item) => ({
                value: item.name,
                label: item.name,
                description: item.columnType,
              })),
            ]}
            value={orderBy}
            onChange={(value) => {
              setOrderBy(value);
              void load(filters, value, orderDir, limit);
            }}
            clearable={false}
          />
        </div>
        <div className="field w-[110px]">
          <span className="field-label">Direction</span>
          <Combobox
            options={[
              { value: 'asc', label: 'ASC' },
              { value: 'desc', label: 'DESC' },
            ]}
            value={orderDir}
            onChange={(next) => {
              const direction = next as 'asc' | 'desc';
              setOrderDir(direction);
              void load(filters, orderBy, direction, limit);
            }}
            clearable={false}
            maxHeight={220}
          />
        </div>
        <div className="field w-[110px]">
          <span className="field-label">Rows</span>
          <Combobox
            options={[50, 100, 200, 500].map((item) => ({
              value: String(item),
              label: String(item),
            }))}
            value={String(limit)}
            onChange={(next) => {
              const nextLimit = Number(next);
              setLimit(nextLimit);
              void load(filters, orderBy, orderDir, nextLimit);
            }}
            clearable={false}
            maxHeight={260}
          />
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto"
          icon={<RefreshCw size={12} />}
          onClick={() => void load(filters, orderBy, orderDir, limit)}
          loading={loading}
        >
          Refresh
        </Button>
      </div>

      {error ? <div className="callout danger">{error}</div> : null}
      {loading && !result ? (
        <div className="flex items-center gap-2 p-6 text-[12px] text-muted">
          <Spinner size={14} /> Loading rows…
        </div>
      ) : result ? (
        <div className="overflow-hidden rounded-xl border border-line-soft">
          <ResultsGrid
            result={result}
            onReveal={() => void load(filters, orderBy, orderDir, limit, true)}
          />
        </div>
      ) : null}
    </div>
  );
}

function TableDetailView({
  detail,
  profileId,
  onRefresh,
  refreshing,
  onBack,
  onOpenRelated,
}: {
  detail: TableDetail;
  profileId: string;
  onRefresh: () => void;
  refreshing: boolean;
  onBack: () => void;
  onOpenRelated: (database: string, table: string) => void;
}) {
  const [tab, setTab] = useState<
    'overview' | 'columns' | 'indexes' | 'relations' | 'data' | 'ddl' | 'triggers'
  >('overview');
  // The preview is mounted on first visit and then kept alive (hidden) so its
  // filters, sort, and row limit survive tab switches and metadata refreshes.
  const [dataVisited, setDataVisited] = useState(false);
  if (tab === 'data' && !dataVisited) {
    setDataVisited(true);
  }
  const dataMounted = dataVisited || tab === 'data';
  const summary = detail.summary;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start gap-3">
        <IconButton label="Back to database" onClick={onBack}>
          <ArrowLeft size={15} />
        </IconButton>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-[22px] font-extrabold tracking-tight">{summary.name}</h1>
            <Badge tone="ember">{summary.type}</Badge>
            {summary.engine ? <Badge>{summary.engine}</Badge> : null}
          </div>
          <div className="mt-1 font-mono text-[10.5px] text-muted">
            {summary.database} · {formatNumber(summary.rowsEstimate)} estimated rows ·{' '}
            {formatBytes(summary.dataBytes + summary.indexBytes)}
          </div>
        </div>
        <div className="flex items-center gap-1">
          <CopyButton text={summary.name} label="Copy name" />
          <Button
            variant="ghost"
            size="sm"
            icon={<RefreshCw size={12} />}
            onClick={onRefresh}
            loading={refreshing}
          >
            Refresh
          </Button>
        </div>
      </div>

      <Tabs
        items={[
          { id: 'overview', label: 'Overview' },
          { id: 'columns', label: 'Columns', count: detail.columns.length },
          { id: 'indexes', label: 'Indexes', count: detail.indexes.length },
          {
            id: 'relations',
            label: 'Relations',
            count: detail.foreignKeys.length + detail.referencedBy.length,
          },
          { id: 'data', label: 'Data' },
          { id: 'ddl', label: 'DDL' },
          { id: 'triggers', label: 'Triggers', count: detail.triggers.length },
        ]}
        value={tab}
        onChange={setTab}
      />

      {tab === 'overview' ? (
        <div className="flex flex-col gap-3">
          <div className="stat-grid stat-grid-6">
            <StatCard label="Estimated rows" value={formatNumber(summary.rowsEstimate)} />
            <StatCard label="Data size" value={formatBytes(summary.dataBytes)} />
            <StatCard label="Index size" value={formatBytes(summary.indexBytes)} />
            <StatCard label="Free space" value={formatBytes(summary.dataFreeBytes)} tone="warn" />
            <StatCard label="Indexes" value={detail.indexes.length} sub="including primary" />
            <StatCard
              label="Columns"
              value={detail.columns.length}
              sub={`${detail.checks.length} checks`}
            />
          </div>
          <Card className="p-4">
            <div className="section-title mb-3">Table metadata</div>
            <div className="grid grid-cols-1 gap-2 text-[12px] sm:grid-cols-2">
              {[
                ['Engine', summary.engine ?? '—'],
                ['Collation', summary.collation ?? '—'],
                ['Created', summary.createdAt ?? '—'],
                ['Updated', summary.updatedAt ?? '—'],
                ['Partitions', String(detail.partitions.length)],
                ['Comment', summary.comment || '—'],
              ].map(([label, value]) => (
                <div
                  key={label}
                  className="flex items-start justify-between gap-3 border-b border-line-soft py-1.5"
                >
                  <span className="text-muted">{label}</span>
                  <span className="max-w-[60%] text-right font-mono text-[10.5px]">{value}</span>
                </div>
              ))}
            </div>
          </Card>
          {detail.checks.length > 0 ? (
            <Card className="p-4">
              <div className="section-title mb-2">Check constraints</div>
              {detail.checks.map((check) => (
                <div key={check.name} className="border-b border-line-soft py-1.5 text-[11.5px]">
                  <span className="font-mono text-muted">{check.name}</span> {check.clause}
                </div>
              ))}
            </Card>
          ) : null}
        </div>
      ) : null}

      {tab === 'columns' ? (
        <div className="overflow-auto rounded-xl border border-line-soft">
          <table className="data-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Column</th>
                <th>Type</th>
                <th>Null</th>
                <th>Key</th>
                <th>Default</th>
                <th>Extra</th>
                <th>Comment</th>
              </tr>
            </thead>
            <tbody>
              {detail.columns.map((column) => (
                <tr key={column.name}>
                  <td className="text-muted/60">{column.position}</td>
                  <td className="font-semibold text-ink">{column.name}</td>
                  <td>{column.columnType}</td>
                  <td>{column.nullable ? 'YES' : 'NO'}</td>
                  <td>
                    {column.key === 'PRI' ? (
                      <Badge tone="ember">
                        <KeyRound size={9} /> PRI
                      </Badge>
                    ) : column.key ? (
                      <Badge tone="info">{column.key}</Badge>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td>{column.defaultValue ?? '—'}</td>
                  <td>{column.extra || '—'}</td>
                  <td className="max-w-[220px] truncate" title={column.comment}>
                    {column.comment || '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {tab === 'indexes' ? (
        <div className="flex flex-col gap-2">
          {detail.indexes.length === 0 ? (
            <EmptyState icon={<KeyRound size={22} />} title="No indexes" />
          ) : (
            detail.indexes.map((index) => (
              <Card key={index.name} className="flex flex-wrap items-center gap-3 p-3">
                <span className="font-mono text-[11.5px] font-semibold text-ink">{index.name}</span>
                {index.name === 'PRIMARY' ? <Badge tone="ember">primary</Badge> : null}
                {index.unique ? <Badge tone="mint">unique</Badge> : null}
                <Badge>{index.type}</Badge>
                {index.duplicateOf ? (
                  <Badge tone="warn">duplicate of {index.duplicateOf}</Badge>
                ) : null}
                {index.redundantOf ? (
                  <Badge tone="warn">redundant prefix of {index.redundantOf}</Badge>
                ) : null}
                <span className="ml-auto font-mono text-[10px] text-muted">
                  {index.columns
                    .map((column) => `${column.name}${column.subPart ? `(${column.subPart})` : ''}`)
                    .join(', ')}
                </span>
                <span className="font-mono text-[10px] text-muted">
                  card {index.cardinality != null ? formatNumber(index.cardinality) : '—'}
                </span>
              </Card>
            ))
          )}
        </div>
      ) : null}

      {tab === 'relations' ? (
        <div className="flex flex-col gap-3">
          <RelationMap detail={detail} onOpen={onOpenRelated} />
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            <Card className="p-3">
              <div className="section-title mb-2">Foreign keys (outgoing)</div>
              {detail.foreignKeys.length === 0 ? (
                <div className="text-[11px] text-muted">None.</div>
              ) : (
                detail.foreignKeys.map((fk) => (
                  <button
                    key={fk.name}
                    type="button"
                    className="flex w-full items-center gap-2 border-b border-line-soft py-2 text-left text-[11px] hover:text-ember"
                    onClick={() => onOpenRelated(fk.referencedDatabase, fk.referencedTable)}
                  >
                    <span className="font-mono text-muted">{fk.name}</span>
                    <span className="font-mono">
                      ({fk.columns.join(', ')}) → {fk.referencedTable}(
                      {fk.referencedColumns.join(', ')})
                    </span>
                    <Badge className="ml-auto" tone="neutral">
                      {fk.onDelete}
                    </Badge>
                  </button>
                ))
              )}
            </Card>
            <Card className="p-3">
              <div className="section-title mb-2">Referenced by (incoming)</div>
              {detail.referencedBy.length === 0 ? (
                <div className="text-[11px] text-muted">None.</div>
              ) : (
                detail.referencedBy.map((fk) => (
                  <button
                    key={fk.name}
                    type="button"
                    className="flex w-full items-center gap-2 border-b border-line-soft py-2 text-left text-[11px] hover:text-ember"
                    onClick={() => onOpenRelated(fk.referencedDatabase, fk.referencedTable)}
                  >
                    <span className="font-mono text-muted">{fk.name}</span>
                    <span className="font-mono">
                      {fk.referencedTable}({fk.referencedColumns.join(', ')}) → (
                      {fk.columns.join(', ')})
                    </span>
                    <Badge className="ml-auto" tone="neutral">
                      {fk.onDelete}
                    </Badge>
                  </button>
                ))
              )}
            </Card>
          </div>
        </div>
      ) : null}

      {dataMounted ? (
        <div className={tab === 'data' ? undefined : 'hidden'}>
          <DataPreview
            key={`${profileId}:${summary.database}:${summary.name}`}
            profileId={profileId}
            database={summary.database}
            table={summary.name}
            columns={detail.columns}
          />
        </div>
      ) : null}

      {tab === 'ddl' ? (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <div className="section-title">Create statement</div>
            <div className="ml-auto flex gap-1">
              {detail.createSql ? <CopyButton text={detail.createSql} label="Copy DDL" /> : null}
              {detail.createSql ? (
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<Download size={12} />}
                  onClick={() => {
                    downloadText(
                      `${summary.name}.sql`,
                      detail.createSql ?? '',
                      'application/sql;charset=utf-8',
                    );
                  }}
                >
                  Download
                </Button>
              ) : null}
            </div>
          </div>
          <CodeBlock
            text={
              detail.createSql ??
              'DDL is not available for this object (permission denied or view definition hidden).'
            }
          />
        </div>
      ) : null}

      {tab === 'triggers' ? (
        <div className="flex flex-col gap-2">
          {detail.triggers.length === 0 ? (
            <EmptyState icon={<Zap size={22} />} title="No triggers" />
          ) : (
            detail.triggers.map((trigger) => (
              <Card key={trigger.name} className="p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-[11.5px] font-semibold text-ink">
                    {trigger.name}
                  </span>
                  <Badge tone="warn">
                    {trigger.timing} {trigger.event}
                  </Badge>
                  <span className="ml-auto font-mono text-[10px] text-muted">
                    {trigger.definer}
                  </span>
                </div>
                <CodeBlock text={trigger.statement} className="mt-2 max-h-40 text-[10.5px]" />
              </Card>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}

/** Identity of a table-detail request: profile + database + table. */
function detailKeyFor(
  profileId: string | null,
  database: string | null,
  table: string | null,
): string {
  return `${profileId ?? ''}\u0000${database ?? ''}\u0000${table ?? ''}`;
}

/** Identity of an objects request: profile + database + request counter. */
function objectsKeyFor(profileId: string | null, database: string | null, request: number): string {
  return `${profileId ?? ''}\u0000${database ?? ''}\u0000${request}`;
}

export function DatabasePage() {
  const [params, setParams] = useSearchParams();
  const activeProfileId = useAppStore((state) => state.activeProfileId);
  const profiles = useAppStore((state) => state.profiles);
  const selectedDatabase = useAppStore((state) => state.selectedDatabase);
  const setDatabase = useAppStore((state) => state.setDatabase);
  const refreshProfiles = useAppStore((state) => state.refreshProfiles);
  const refreshDatabases = useAppStore((state) => state.refreshDatabases);
  const toast = useAppStore((state) => state.toast);

  const activeProfile = profiles.find((profile) => profile.id === activeProfileId) ?? null;
  const [createOpen, setCreateOpen] = useState(false);

  const dbParam = params.get('db');
  const tableParam = params.get('table');
  const objectParam = params.get('object');
  const objectType = params.get('objectType') ?? 'view';
  const routineType = params.get('routineType') as 'FUNCTION' | 'PROCEDURE' | null;

  // Objects live in the app store: the sidebar, the workspace, and post-DDL
  // refreshes all share one copy, so this page never holds a second snapshot.
  const objects = useAppStore((state) => state.objects);
  const refreshObjects = useAppStore((state) => state.refreshObjects);
  const [objectsRequest, setObjectsRequest] = useState(0);
  // The objects response is tagged with the request it belongs to, so the
  // loading flag and the error are derived from the request that is running.
  const objectsKey = objectsKeyFor(activeProfileId, selectedDatabase, objectsRequest);
  const [objectsState, setObjectsState] = useState<{ key: string; error: string | null } | null>(
    null,
  );
  const objectsLoading =
    Boolean(activeProfileId && selectedDatabase) && objectsState?.key !== objectsKey;
  const objectsError = objectsState?.key === objectsKey ? objectsState.error : null;

  // The detail is tagged with the profile/database/table it was fetched for, so
  // a response for table A can never render under table B's URL.
  const detailKey = detailKeyFor(activeProfileId, selectedDatabase, tableParam);
  const [detailState, setDetailState] = useState<{
    key: string;
    fetchKey: string;
    detail: TableDetail | null;
    error: string | null;
  } | null>(null);
  const detailRequest = useRef(0);
  const detail = detailState?.key === detailKey ? detailState.detail : null;
  const detailError = detailState?.key === detailKey ? detailState.error : null;
  const [refreshKey, setRefreshKey] = useState(0);
  // A refresh refetches the same table, so the pending flag follows the fetch
  // the state belongs to rather than the table identity.
  const detailFetchKey = `${detailKey}\u0000${refreshKey}`;
  const detailLoading = detailState?.fetchKey !== detailFetchKey;
  const [search, setSearch] = useState('');
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({
    tables: true,
    views: true,
    routines: false,
    triggers: false,
    events: false,
  });
  const [objectModal, setObjectModal] = useState<{
    open: boolean;
    title: string;
    subtitle: string;
    fields: { label: string; value: string }[];
    text: string;
  }>({ open: false, title: '', subtitle: '', fields: [], text: '' });

  useEffect(() => {
    if (dbParam && dbParam !== selectedDatabase) {
      setDatabase(dbParam);
    }
    // The db query parameter is an entry point, not a two-way binding.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dbParam]);

  useEffect(() => {
    if (!selectedDatabase) return;
    if (dbParam === selectedDatabase) return;
    const next = new URLSearchParams(params);
    next.set('db', selectedDatabase);
    setParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDatabase]);

  // `?create=1` is a one-shot entry point: it opens the dialog and is then
  // dropped from the URL. The dialog is opened while rendering so it never
  // renders closed first.
  const createParam = params.get('create');
  const [lastCreateParam, setLastCreateParam] = useState<string | null>(null);
  if (createParam !== lastCreateParam) {
    setLastCreateParam(createParam);
    if (createParam === '1') setCreateOpen(true);
  }

  useEffect(() => {
    if (params.get('create') !== '1') return;
    const next = new URLSearchParams(params);
    next.delete('create');
    setParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  useEffect(() => {
    if (!activeProfileId || !selectedDatabase) return;
    let cancelled = false;
    const key = objectsKeyFor(activeProfileId, selectedDatabase, objectsRequest);
    void refreshObjects()
      .catch((error) => {
        if (cancelled) return;
        setObjectsState({
          key,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        if (cancelled) return;
        // refreshObjects deliberately swallows transport errors, so a completed
        // call with no objects in the store means the fetch failed.
        setObjectsState({
          key,
          error: useAppStore.getState().objects
            ? null
            : 'Could not load the tables, views, and routines for this database.',
        });
      });
    return () => {
      cancelled = true;
    };
  }, [activeProfileId, selectedDatabase, refreshObjects, objectsRequest]);

  useEffect(() => {
    if (!activeProfileId || !selectedDatabase || !tableParam) return;
    const key = detailKeyFor(activeProfileId, selectedDatabase, tableParam);
    const requestId = detailRequest.current + 1;
    detailRequest.current = requestId;
    dbApi
      .tableDetail(activeProfileId, selectedDatabase, tableParam)
      .then((result) => {
        if (detailRequest.current !== requestId) return;
        setDetailState({ key, fetchKey: detailFetchKey, detail: result, error: null });
      })
      .catch((error) => {
        if (detailRequest.current !== requestId) return;
        const message = error instanceof Error ? error.message : String(error);
        setDetailState({ key, fetchKey: detailFetchKey, detail: null, error: message });
      });
    return () => {
      // Invalidate the in-flight response even if it never settles.
      if (detailRequest.current === requestId) detailRequest.current += 1;
    };
  }, [activeProfileId, selectedDatabase, tableParam, toast, detailFetchKey]);

  useEffect(() => {
    if (!activeProfileId || !selectedDatabase || !objectParam) return;
    let cancelled = false;
    void (async () => {
      try {
        const info = await dbApi.objectInfo(
          activeProfileId,
          selectedDatabase,
          objectType as 'view' | 'routine' | 'trigger' | 'event',
          objectParam,
          routineType ?? undefined,
        );
        if (cancelled) return;
        const title = (info.name as string) ?? (info.TRIGGER_NAME as string) ?? objectParam;
        const fields: { label: string; value: string }[] = [];
        let text = '';
        if (objectType === 'view') {
          fields.push(
            { label: 'Definer', value: String(info.definer ?? '—') },
            { label: 'Security', value: String(info.securityType ?? '—') },
            { label: 'Check option', value: String(info.checkOption ?? '—') },
            { label: 'Updatable', value: info.updatable ? 'yes' : 'no' },
          );
          text = String(info.definition ?? '');
        } else if (objectType === 'routine') {
          fields.push(
            { label: 'Type', value: String(info.type ?? '—') },
            { label: 'Definer', value: String(info.definer ?? '—') },
            { label: 'Security', value: String(info.securityType ?? '—') },
            { label: 'Parameters', value: String(info.parameters ?? '—') },
          );
          text = String(info.body ?? '');
        } else if (objectType === 'trigger') {
          fields.push(
            { label: 'Timing', value: String(info.timing ?? '—') },
            { label: 'Event', value: String(info.event ?? '—') },
            { label: 'Table', value: String(info.table ?? '—') },
            { label: 'Definer', value: String(info.definer ?? '—') },
          );
          text = String(info.statement ?? '');
        } else {
          fields.push(
            { label: 'Status', value: String(info.status ?? '—') },
            { label: 'Type', value: String(info.eventType ?? '—') },
            { label: 'Definer', value: String(info.definer ?? '—') },
            { label: 'On completion', value: String(info.onCompletion ?? '—') },
          );
          text = String(info.comment ?? '');
        }
        setObjectModal({
          open: true,
          title,
          subtitle: `${objectType} · ${selectedDatabase}`,
          fields,
          text,
        });
      } catch (error) {
        if (!cancelled) toast(error instanceof Error ? error.message : String(error), 'error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeProfileId, selectedDatabase, objectParam, objectType, routineType, toast]);

  const filteredTables = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const list = objects?.tables ?? [];
    return needle ? list.filter((table) => table.name.toLowerCase().includes(needle)) : list;
  }, [objects?.tables, search]);
  const filteredViews = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const list = objects?.views ?? [];
    return needle ? list.filter((view) => view.name.toLowerCase().includes(needle)) : list;
  }, [objects?.views, search]);

  /** Patch the query string without dropping unrelated parameters. */
  const patchParams = (patch: Record<string, string | null>): void => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) next.delete(key);
      else next.set(key, value);
    }
    setParams(next);
  };

  const selectTable = (database: string, table: string): void => {
    if (database !== selectedDatabase) setDatabase(database);
    patchParams({
      db: database,
      table,
      object: null,
      objectType: null,
      routineType: null,
    });
  };

  const selectObject = (
    database: string,
    type: 'view' | 'routine' | 'trigger' | 'event',
    name: string,
    rType?: 'FUNCTION' | 'PROCEDURE',
  ): void => {
    if (database !== selectedDatabase) setDatabase(database);
    patchParams({
      db: database,
      table: null,
      object: name,
      objectType: type,
      routineType: rType ?? null,
    });
  };

  const backToDatabase = (): void => {
    patchParams({
      db: selectedDatabase,
      table: null,
      object: null,
      objectType: null,
      routineType: null,
    });
  };

  if (!selectedDatabase) {
    return (
      <div className="page">
        <PageHeader
          title="Database"
          actions={
            activeProfile ? (
              <Button
                variant="primary"
                size="sm"
                icon={<Plus size={13} />}
                onClick={() => setCreateOpen(true)}
              >
                Create database
              </Button>
            ) : null
          }
        />
        <EmptyState
          icon={<Database size={24} />}
          title="No database selected"
          copy="Choose a database from the selector in the top bar, or create an empty one to get started."
        />
        {activeProfile ? (
          <CreateDatabaseModal
            open={createOpen}
            onClose={() => setCreateOpen(false)}
            profile={activeProfile}
            onCreated={(result) => {
              void refreshProfiles();
              void refreshDatabases();
              setDatabase(result.database.name);
            }}
          />
        ) : null}
      </div>
    );
  }

  const totalSize = (objects?.tables ?? []).reduce(
    (sum, table) => sum + table.dataBytes + table.indexBytes,
    0,
  );

  return (
    <div className="page">
      <div className="flex min-h-[640px] flex-col gap-0 overflow-hidden rounded-2xl border border-line bg-panel/40 md:flex-row">
        <aside className="w-full shrink-0 border-b border-line-soft bg-panel/40 md:w-[270px] md:border-b-0 md:border-r">
          <div className="border-b border-line-soft p-3">
            <div className="flex items-center gap-2">
              <Database size={14} className="text-ember" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[12px] font-semibold">{selectedDatabase}</div>
                <div className="text-[10px] text-muted">
                  {objects
                    ? `${objects.tables.length} tables · ${objects.views.length} views`
                    : objectsError
                      ? 'unavailable'
                      : 'loading…'}
                </div>
              </div>
              <IconButton
                label="Refresh objects"
                onClick={() => setObjectsRequest((value) => value + 1)}
              >
                {objectsLoading ? <Spinner size={13} /> : <RefreshCw size={13} />}
              </IconButton>
            </div>
            <div className="relative mt-2">
              <Search
                size={12}
                className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted"
              />
              <input
                className="input input-search py-1.5 text-[11px]"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Filter objects…"
                aria-label="Filter database objects"
              />
            </div>
          </div>

          <div className="h-[260px] overflow-auto p-2 md:h-[560px]">
            <Section
              label="Tables"
              count={filteredTables.length}
              open={openSections.tables}
              onToggle={() =>
                setOpenSections((current) => ({ ...current, tables: !current.tables }))
              }
            >
              {filteredTables.map((table) => (
                <button
                  key={table.name}
                  type="button"
                  className={cn(
                    'tree-item w-full text-left',
                    table.name === tableParam && 'active',
                  )}
                  onClick={() => selectTable(selectedDatabase, table.name)}
                >
                  <Table2 size={12} className="shrink-0 text-muted" />
                  <span>{table.name}</span>
                  <span className="tree-rows">{formatNumber(table.rowsEstimate)}</span>
                </button>
              ))}
              {filteredTables.length === 0 ? (
                <div className="px-2 py-3 text-[10.5px] text-muted">No tables match.</div>
              ) : null}
            </Section>

            <Section
              label="Views"
              count={filteredViews.length}
              open={openSections.views}
              onToggle={() => setOpenSections((current) => ({ ...current, views: !current.views }))}
            >
              {filteredViews.map((view) => (
                <button
                  key={view.name}
                  type="button"
                  className="tree-item w-full text-left"
                  onClick={() => selectObject(selectedDatabase, 'view', view.name)}
                >
                  <Eye size={12} className="shrink-0 text-muted" />
                  <span>{view.name}</span>
                </button>
              ))}
            </Section>

            <Section
              label="Routines"
              count={objects?.routines.length ?? 0}
              open={openSections.routines}
              onToggle={() =>
                setOpenSections((current) => ({ ...current, routines: !current.routines }))
              }
            >
              {(objects?.routines ?? []).map((routine) => (
                <button
                  key={`${routine.type}-${routine.name}`}
                  type="button"
                  className="tree-item w-full text-left"
                  onClick={() =>
                    selectObject(selectedDatabase, 'routine', routine.name, routine.type)
                  }
                >
                  <span className="text-[10px] font-bold text-ember">
                    {routine.type === 'FUNCTION' ? 'FN' : 'PR'}
                  </span>
                  <span>{routine.name}</span>
                </button>
              ))}
            </Section>

            <Section
              label="Triggers"
              count={objects?.triggers.length ?? 0}
              open={openSections.triggers}
              onToggle={() =>
                setOpenSections((current) => ({ ...current, triggers: !current.triggers }))
              }
            >
              {(objects?.triggers ?? []).map((trigger) => (
                <button
                  key={trigger.name}
                  type="button"
                  className="tree-item w-full text-left"
                  onClick={() => selectObject(selectedDatabase, 'trigger', trigger.name)}
                >
                  <span className="text-[10px] font-bold text-warn">TR</span>
                  <span>{trigger.name}</span>
                </button>
              ))}
            </Section>

            <Section
              label="Events"
              count={objects?.events.length ?? 0}
              open={openSections.events}
              onToggle={() =>
                setOpenSections((current) => ({ ...current, events: !current.events }))
              }
            >
              {(objects?.events ?? []).map((event) => (
                <button
                  key={event.name}
                  type="button"
                  className="tree-item w-full text-left"
                  onClick={() => selectObject(selectedDatabase, 'event', event.name)}
                >
                  <span className="text-[10px] font-bold text-info">EV</span>
                  <span>{event.name}</span>
                </button>
              ))}
            </Section>
          </div>
        </aside>

        <div className="min-w-0 flex-1 p-4">
          {tableParam ? (
            detail ? (
              <TableDetailView
                detail={detail}
                profileId={activeProfileId ?? ''}
                onRefresh={() => setRefreshKey((value) => value + 1)}
                refreshing={detailLoading}
                onBack={backToDatabase}
                onOpenRelated={selectTable}
              />
            ) : detailLoading || !detailError ? (
              <div className="flex items-center gap-2 p-8 text-[12px] text-muted">
                <Spinner size={15} /> Loading table…
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                <PageHeader
                  title={tableParam}
                  actions={
                    <Button
                      variant="secondary"
                      size="sm"
                      icon={<RefreshCw size={12} />}
                      onClick={() => setRefreshKey((value) => value + 1)}
                    >
                      Retry
                    </Button>
                  }
                />
                <div className="callout danger">{detailError}</div>
              </div>
            )
          ) : (
            <div className="flex flex-col gap-4">
              <PageHeader
                title={selectedDatabase}
                actions={
                  <>
                    <Button
                      variant="primary"
                      size="sm"
                      icon={<Plus size={12} />}
                      onClick={() => setCreateOpen(true)}
                      disabled={!activeProfile}
                    >
                      Create database
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      icon={<RefreshCw size={12} />}
                      onClick={() => setObjectsRequest((value) => value + 1)}
                      loading={objectsLoading}
                    >
                      Refresh
                    </Button>
                  </>
                }
              />
              <div className="stat-grid stat-grid-6">
                <StatCard
                  label="Tables"
                  value={objects?.tables.length ?? '—'}
                  icon={<Table2 size={14} />}
                  tone="ember"
                />
                <StatCard
                  label="Views"
                  value={objects?.views.length ?? '—'}
                  icon={<Eye size={14} />}
                />
                <StatCard label="Routines" value={objects?.routines.length ?? '—'} />
                <StatCard label="Triggers" value={objects?.triggers.length ?? '—'} />
                <StatCard label="Events" value={objects?.events.length ?? '—'} />
                <StatCard label="Total size" value={formatBytes(totalSize)} sub="data + indexes" />
              </div>
              <Card className="p-4">
                <div className="mb-3 flex items-center gap-2">
                  <div className="section-title">Tables</div>
                </div>
                {objectsError && !objects ? (
                  <div className="callout danger flex flex-wrap items-center gap-2">
                    <span className="flex-1">{objectsError}</span>
                    <Button
                      variant="secondary"
                      size="sm"
                      icon={<RefreshCw size={12} />}
                      onClick={() => setObjectsRequest((value) => value + 1)}
                    >
                      Retry
                    </Button>
                  </div>
                ) : objectsLoading && !objects ? (
                  <div className="flex items-center gap-2 py-6 text-[12px] text-muted">
                    <Spinner size={14} /> Loading objects…
                  </div>
                ) : filteredTables.length === 0 ? (
                  <EmptyState
                    icon={<Table2 size={22} />}
                    title="No tables"
                    copy="This database has no base tables visible to your account."
                  />
                ) : (
                  <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
                    {filteredTables.map((table) => (
                      <TableLink
                        key={table.name}
                        table={table}
                        onOpen={() => selectTable(selectedDatabase, table.name)}
                      />
                    ))}
                  </div>
                )}
              </Card>
            </div>
          )}
        </div>
      </div>

      <ModalForObject
        state={objectModal}
        onClose={() => {
          setObjectModal((current) => ({ ...current, open: false }));
          patchParams({ object: null, objectType: null, routineType: null });
        }}
      />

      {activeProfile ? (
        <CreateDatabaseModal
          open={createOpen}
          onClose={() => setCreateOpen(false)}
          profile={activeProfile}
          onCreated={(result) => {
            void refreshProfiles();
            void refreshDatabases();
            setDatabase(result.database.name);
          }}
        />
      ) : null}
    </div>
  );
}

function Section({
  label,
  count,
  open,
  onToggle,
  children,
}: {
  label: string;
  count: number;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="tree-section">
      <button type="button" className="tree-header w-full" onClick={onToggle}>
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span>{label}</span>
        <Badge className="ml-auto">{count}</Badge>
      </button>
      {open ? <div className="tree-list">{children}</div> : null}
    </div>
  );
}

function ModalForObject({
  state,
  onClose,
}: {
  state: {
    open: boolean;
    title: string;
    subtitle: string;
    fields: { label: string; value: string }[];
    text: string;
  };
  onClose: () => void;
}) {
  return (
    <Modal
      open={state.open}
      onClose={onClose}
      title={state.title}
      subtitle={state.subtitle}
      size="wide"
      footer={state.text ? <CopyButton text={state.text} label="Copy definition" /> : null}
    >
      <div className="flex flex-col gap-3">
        {state.fields.length > 0 ? (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {state.fields.map((field) => (
              <div
                key={field.label}
                className="rounded-lg border border-line-soft bg-panel-2/40 p-2"
              >
                <div className="mono-label">{field.label}</div>
                <div className="mt-1 break-words font-mono text-[10.5px]">{field.value}</div>
              </div>
            ))}
          </div>
        ) : null}
        {state.text ? <CodeBlock text={state.text} /> : null}
      </div>
    </Modal>
  );
}
