import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  Copy,
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
  Trash2,
  X,
} from 'lucide-react';
import type {
  ColumnInfo,
  DatabaseObjects,
  ForeignKeyInfo,
  TableDataFilter,
  TableDetail,
  TableSummary,
} from '@shared/types';
import { useAppStore } from '@/store/app-store';
import { dbApi } from '@/lib/db-api';
import { formatBytes, formatNumber } from '@/lib/format';
import { ResultsGrid } from '@/components/ResultsGrid';
import { CreateDatabaseModal } from '@/components/CreateDatabaseModal';
import { Combobox } from '@/components/Combobox';
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  CopyButton,
  EmptyState,
  IconButton,
  Input,
  Modal,
  PageHeader,
  Spinner,
  StatCard,
  Tabs,
  cn,
} from '@/components/ui';

function CodeBlock({ text, className }: { text: string; className?: string }) {
  return <pre className={cn('code-block', className)}>{text}</pre>;
}

function TableLink({
  table,
  onOpen,
}: {
  table: TableSummary;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      className="flex w-full items-center gap-3 rounded-lg border border-line-soft bg-panel-2/40 px-3 py-2 text-left transition hover:border-ember/35 hover:bg-panel-2"
      onClick={onOpen}
    >
      <Table2 size={14} className="shrink-0 text-muted" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12px] font-semibold text-ink">{table.name}</div>
        <div className="mt-0.5 font-mono text-[9.5px] text-muted">
          {table.engine ?? 'view'} · {formatNumber(table.rowsEstimate)} rows ·{' '}
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
    return (
      <EmptyState
        icon={<Link2 size={22} />}
        title="No relationships"
        copy="This table has no foreign keys pointing in or out."
      />
    );
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

  return (
    <div className="overflow-auto rounded-xl border border-line-soft bg-panel-2/25">
      <svg width={width} height={height} role="img" aria-label="Table relationships">
        <defs>
          <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
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
              <text x={190} y={y - 6} fill="var(--color-muted)" fontSize={9} fontFamily="var(--font-mono)">
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
              <text x={centerX + 92} y={centerY + 14} fill="var(--color-muted)" fontSize={9} fontFamily="var(--font-mono)">
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
          <text x={centerX} y={centerY + 4} textAnchor="middle" fill="var(--color-ink)" fontSize={12} fontWeight={700}>
            {detail.summary.name}
          </text>
        </g>

        {leftNodes.map((fk, index) => {
          const y = nodeY(index, leftNodes.length);
          return (
            <g
              key={`in-node-${fk.name}`}
              className="cursor-pointer"
              onClick={() => onOpen(fk.referencedDatabase, fk.referencedTable)}
            >
              <rect x={30} y={y - 18} width={150} height={36} rx={9} fill="var(--color-panel-2)" stroke="var(--color-line)" />
              <text x={105} y={y + 4} textAnchor="middle" fill="var(--color-ink-soft)" fontSize={11}>
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
              className="cursor-pointer"
              onClick={() => onOpen(fk.referencedDatabase, fk.referencedTable)}
            >
              <rect x={width - 180} y={y - 18} width={150} height={36} rx={9} fill="var(--color-panel-2)" stroke="var(--color-line)" />
              <text x={width - 105} y={y + 4} textAnchor="middle" fill="var(--color-ink-soft)" fontSize={11}>
                {fk.referencedTable}
              </text>
            </g>
          );
        })}
      </svg>
      <div className="border-t border-line-soft px-3 py-2 text-[10px] text-muted">
        Left: tables referencing this table. Right: tables this table references. Click a node to open it.
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
  const toast = useAppStore((state) => state.toast);
  const [limit, setLimit] = useState(100);
  const [orderBy, setOrderBy] = useState('');
  const [orderDir, setOrderDir] = useState<'asc' | 'desc'>('asc');
  const [filters, setFilters] = useState<TableDataFilter[]>([]);
  const [column, setColumn] = useState(columns[0]?.name ?? '');
  const [operator, setOperator] = useState<TableDataFilter['operator']>('=');
  const [value, setValue] = useState('');
  const [result, setResult] = useState<Awaited<ReturnType<typeof dbApi.tableData>> | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revealConfirm, setRevealConfirm] = useState(false);

  const load = async (
    nextFilters = filters,
    nextOrder = orderBy,
    nextDir = orderDir,
    nextLimit = limit,
    nextReveal = false,
  ): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const data = await dbApi.tableData(profileId, database, table, {
        limit: nextLimit,
        orderBy: nextOrder || null,
        orderDir: nextDir,
        filters: nextFilters,
        revealSensitive: nextReveal,
      });
      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load([], '', 'asc', 100);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileId, database, table]);

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
          icon={loading ? <Spinner size={12} /> : <RefreshCw size={12} />}
          onClick={() => void load()}
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
            onReveal={() => setRevealConfirm(true)}
          />
        </div>
      ) : null}

      <ConfirmDialog
        open={revealConfirm}
        onClose={() => setRevealConfirm(false)}
        onConfirm={() => {
          setRevealConfirm(false);
          void load(filters, orderBy, orderDir, limit, true);
        }}
        title="Reveal sensitive values?"
        message="The table preview will reload without masking credential-like columns. Only continue in a private environment."
        confirmLabel="Reveal values"
        danger
      />
    </div>
  );
}

function TableDetailView({
  detail,
  onRefresh,
  refreshing,
  onBack,
  onOpenRelated,
}: {
  detail: TableDetail;
  onRefresh: () => void;
  refreshing: boolean;
  onBack: () => void;
  onOpenRelated: (database: string, table: string) => void;
}) {
  const [tab, setTab] = useState<'overview' | 'columns' | 'indexes' | 'relations' | 'data' | 'ddl' | 'triggers'>(
    'overview',
  );
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
            icon={refreshing ? <Spinner size={12} /> : <RefreshCw size={12} />}
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
          <div className="stat-grid">
            <StatCard label="Estimated rows" value={formatNumber(summary.rowsEstimate)} sub="InnoDB estimate" />
            <StatCard label="Data size" value={formatBytes(summary.dataBytes)} sub="DATA_LENGTH" />
            <StatCard label="Index size" value={formatBytes(summary.indexBytes)} sub="INDEX_LENGTH" />
            <StatCard label="Free space" value={formatBytes(summary.dataFreeBytes)} sub="DATA_FREE" tone="warn" />
            <StatCard label="Indexes" value={detail.indexes.length} sub="including primary" />
            <StatCard label="Columns" value={detail.columns.length} sub={`${detail.checks.length} checks`} />
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
                <div key={label} className="flex items-start justify-between gap-3 border-b border-line-soft py-1.5">
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
            <EmptyState icon={<KeyRound size={22} />} title="No indexes" copy="This table has no index definitions." />
          ) : (
            detail.indexes.map((index) => (
              <Card key={index.name} className="flex flex-wrap items-center gap-3 p-3">
                <span className="font-mono text-[11.5px] font-semibold text-ink">{index.name}</span>
                {index.name === 'PRIMARY' ? <Badge tone="ember">primary</Badge> : null}
                {index.unique ? <Badge tone="mint">unique</Badge> : null}
                <Badge>{index.type}</Badge>
                {index.duplicateOf ? <Badge tone="warn">duplicate of {index.duplicateOf}</Badge> : null}
                {index.redundantOf ? <Badge tone="warn">redundant prefix of {index.redundantOf}</Badge> : null}
                <span className="ml-auto font-mono text-[10px] text-muted">
                  {index.columns.map((column) => `${column.name}${column.subPart ? `(${column.subPart})` : ''}`).join(', ')}
                </span>
                <span className="font-mono text-[9.5px] text-muted">
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
                      ({fk.columns.join(', ')}) → {fk.referencedTable}({fk.referencedColumns.join(', ')})
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
                      {fk.referencedTable}({fk.referencedColumns.join(', ')}) → ({fk.columns.join(', ')})
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

      {tab === 'data' ? (
        <DataPreview
          key={summary.name}
          profileId={useAppStore.getState().activeProfileId ?? ''}
          database={summary.database}
          table={summary.name}
          columns={detail.columns}
        />
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
                    const blob = new Blob([detail.createSql ?? ''], { type: 'text/plain;charset=utf-8' });
                    const url = URL.createObjectURL(blob);
                    const anchor = document.createElement('a');
                    anchor.href = url;
                    anchor.download = `${summary.name}.sql`;
                    anchor.click();
                    URL.revokeObjectURL(url);
                  }}
                >
                  Download
                </Button>
              ) : null}
            </div>
          </div>
          <CodeBlock text={detail.createSql ?? 'DDL is not available for this object (permission denied or view definition hidden).'} />
        </div>
      ) : null}

      {tab === 'triggers' ? (
        <div className="flex flex-col gap-2">
          {detail.triggers.length === 0 ? (
            <EmptyState icon={<SparklesIcon />} title="No triggers" copy="No triggers are attached to this table." />
          ) : (
            detail.triggers.map((trigger) => (
              <Card key={trigger.name} className="p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-[11.5px] font-semibold text-ink">{trigger.name}</span>
                  <Badge tone="warn">
                    {trigger.timing} {trigger.event}
                  </Badge>
                  <span className="ml-auto font-mono text-[9.5px] text-muted">{trigger.definer}</span>
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

function SparklesIcon() {
  return <RefreshCw size={22} />;
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

  const [objects, setObjects] = useState<DatabaseObjects | null>(null);
  const [objectsLoading, setObjectsLoading] = useState(false);
  const [detail, setDetail] = useState<TableDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
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

  useEffect(() => {
    if (params.get('create') !== '1') return;
    setCreateOpen(true);
    const next = new URLSearchParams(params);
    next.delete('create');
    setParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  useEffect(() => {
    if (!activeProfileId || !selectedDatabase) {
      setObjects(null);
      return;
    }
    let cancelled = false;
    setObjectsLoading(true);
    dbApi
      .objects(activeProfileId, selectedDatabase)
      .then((result) => {
        if (!cancelled) setObjects(result);
      })
      .catch((error) => {
        if (!cancelled) toast(error instanceof Error ? error.message : String(error), 'error');
      })
      .finally(() => {
        if (!cancelled) setObjectsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeProfileId, selectedDatabase, refreshKey, toast]);

  useEffect(() => {
    if (!activeProfileId || !selectedDatabase || !tableParam) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    dbApi
      .tableDetail(activeProfileId, selectedDatabase, tableParam)
      .then((result) => {
        if (!cancelled) setDetail(result);
      })
      .catch((error) => {
        if (!cancelled) toast(error instanceof Error ? error.message : String(error), 'error');
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeProfileId, selectedDatabase, tableParam, refreshKey, toast]);

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
        const title =
          (info.name as string) ??
          (info.TRIGGER_NAME as string) ??
          objectParam;
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

  const selectTable = (database: string, table: string): void => {
    if (database !== selectedDatabase) setDatabase(database);
    const next = new URLSearchParams();
    next.set('db', database);
    next.set('table', table);
    setParams(next);
  };

  const selectObject = (
    database: string,
    type: 'view' | 'routine' | 'trigger' | 'event',
    name: string,
    rType?: 'FUNCTION' | 'PROCEDURE',
  ): void => {
    if (database !== selectedDatabase) setDatabase(database);
    const next = new URLSearchParams();
    next.set('db', database);
    next.set('object', name);
    next.set('objectType', type);
    if (rType) next.set('routineType', rType);
    setParams(next);
  };

  const backToDatabase = (): void => {
    const next = new URLSearchParams();
    if (selectedDatabase) next.set('db', selectedDatabase);
    setParams(next);
  };

  if (!selectedDatabase) {
    return (
      <div className="page">
        <PageHeader
          title="Database"
          subtitle="Select a database in the top bar to explore its objects."
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
      <div className="flex min-h-[640px] gap-0 overflow-hidden rounded-2xl border border-line bg-panel/40">
        <aside className="w-[270px] shrink-0 border-r border-line-soft bg-panel/40">
          <div className="border-b border-line-soft p-3">
            <div className="flex items-center gap-2">
              <Database size={14} className="text-ember" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[12px] font-semibold">{selectedDatabase}</div>
                <div className="text-[9.5px] text-muted">
                  {objects
                    ? `${objects.tables.length} tables · ${objects.views.length} views`
                    : 'loading…'}
                </div>
              </div>
              <IconButton label="Refresh objects" onClick={() => setRefreshKey((value) => value + 1)}>
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
              />
            </div>
          </div>

          <div className="h-[560px] overflow-auto p-2">
            <Section
              id="tables"
              label="Tables"
              count={filteredTables.length}
              open={openSections.tables}
              onToggle={() => setOpenSections((current) => ({ ...current, tables: !current.tables }))}
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
              id="views"
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
              id="routines"
              label="Routines"
              count={objects?.routines.length ?? 0}
              open={openSections.routines}
              onToggle={() => setOpenSections((current) => ({ ...current, routines: !current.routines }))}
            >
              {(objects?.routines ?? []).map((routine) => (
                <button
                  key={`${routine.type}-${routine.name}`}
                  type="button"
                  className="tree-item w-full text-left"
                  onClick={() =>
                    selectObject(
                      selectedDatabase,
                      'routine',
                      routine.name,
                      routine.type,
                    )
                  }
                >
                  <span className="text-[8px] font-bold text-ember">
                    {routine.type === 'FUNCTION' ? 'FN' : 'PR'}
                  </span>
                  <span>{routine.name}</span>
                </button>
              ))}
            </Section>

            <Section
              id="triggers"
              label="Triggers"
              count={objects?.triggers.length ?? 0}
              open={openSections.triggers}
              onToggle={() => setOpenSections((current) => ({ ...current, triggers: !current.triggers }))}
            >
              {(objects?.triggers ?? []).map((trigger) => (
                <button
                  key={trigger.name}
                  type="button"
                  className="tree-item w-full text-left"
                  onClick={() => selectObject(selectedDatabase, 'trigger', trigger.name)}
                >
                  <span className="text-[8px] font-bold text-warn">TR</span>
                  <span>{trigger.name}</span>
                </button>
              ))}
            </Section>

            <Section
              id="events"
              label="Events"
              count={objects?.events.length ?? 0}
              open={openSections.events}
              onToggle={() => setOpenSections((current) => ({ ...current, events: !current.events }))}
            >
              {(objects?.events ?? []).map((event) => (
                <button
                  key={event.name}
                  type="button"
                  className="tree-item w-full text-left"
                  onClick={() => selectObject(selectedDatabase, 'event', event.name)}
                >
                  <span className="text-[8px] font-bold text-info">EV</span>
                  <span>{event.name}</span>
                </button>
              ))}
            </Section>
          </div>
        </aside>

        <div className="min-w-0 flex-1 p-4">
          {detailLoading ? (
            <div className="flex items-center gap-2 p-8 text-[12px] text-muted">
              <Spinner size={15} /> Loading table…
            </div>
          ) : tableParam && detail ? (
            <TableDetailView
              detail={detail}
              onRefresh={() => setRefreshKey((value) => value + 1)}
              refreshing={detailLoading}
              onBack={backToDatabase}
              onOpenRelated={selectTable}
            />
          ) : (
            <div className="flex flex-col gap-4">
              <PageHeader
                title={selectedDatabase}
                subtitle="Browse tables, views, routines, triggers, and events."
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
                      icon={objectsLoading ? <Spinner size={12} /> : <RefreshCw size={12} />}
                      onClick={() => setRefreshKey((value) => value + 1)}
                      loading={objectsLoading}
                    >
                      Refresh
                    </Button>
                  </>
                }
              />
              <div className="stat-grid">
                <StatCard label="Tables" value={objects?.tables.length ?? '—'} icon={<Table2 size={14} />} tone="ember" />
                <StatCard label="Views" value={objects?.views.length ?? '—'} icon={<Eye size={14} />} />
                <StatCard label="Routines" value={objects?.routines.length ?? '—'} />
                <StatCard label="Triggers" value={objects?.triggers.length ?? '—'} />
                <StatCard label="Events" value={objects?.events.length ?? '—'} />
                <StatCard label="Total size" value={formatBytes(totalSize)} sub="data + indexes" />
              </div>
              <Card className="p-4">
                <div className="mb-3 flex items-center gap-2">
                  <div className="section-title">Tables</div>
                  <Badge className="ml-auto">{filteredTables.length}</Badge>
                </div>
                {objectsLoading ? (
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
          const next = new URLSearchParams();
          if (selectedDatabase) next.set('db', selectedDatabase);
          if (tableParam) next.set('table', tableParam);
          setParams(next);
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
  id,
  label,
  count,
  open,
  onToggle,
  children,
}: {
  id: string;
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
      footer={
        state.text ? <CopyButton text={state.text} label="Copy definition" /> : null
      }
    >
      <div className="flex flex-col gap-3">
        {state.fields.length > 0 ? (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {state.fields.map((field) => (
              <div key={field.label} className="rounded-lg border border-line-soft bg-panel-2/40 p-2">
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
