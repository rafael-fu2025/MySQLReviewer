import { useMemo, useState } from 'react';
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Filter,
  Search,
  ShieldAlert,
} from 'lucide-react';
import type { Finding, FindingCategory, FindingGroup, Severity } from '@shared/types';
import { CATEGORY_LABELS, SEVERITY_ORDER } from '@shared/types';
import {
  Badge,
  Button,
  EmptyState,
  SearchInput,
  SeverityBadge,
  cn,
  severityCounts,
} from './ui';
import { Combobox } from './Combobox';

export function FindingCard({
  finding,
  compact = false,
  onJumpToLine,
}: {
  finding: Finding;
  compact?: boolean;
  onJumpToLine?: (line: number) => void;
}) {
  const object = finding.object;
  const objectLabel = object
    ? [
        object.database && object.table
          ? `${object.database}.${object.table}`
          : object.table,
        object.column,
        object.index,
        object.user ? `'${object.user}'@'${object.host ?? ''}'` : object.host,
      ]
        .filter(Boolean)
        .join(' · ')
    : '';
  return (
    <div className={cn('finding', `sev-${finding.severity}`)}>
      <div className="flex flex-wrap items-center gap-2">
        <SeverityBadge severity={finding.severity} />
        <span className="finding-title">{finding.title}</span>
        {finding.source !== 'rule' ? (
          <Badge tone={finding.source === 'ai' ? 'info' : 'neutral'}>{finding.source}</Badge>
        ) : null}
        {finding.confidence === 'low' ? <Badge tone="warn">low confidence</Badge> : null}
        <span className="ml-auto font-mono text-[9.5px] text-muted">{finding.ruleId}</span>
      </div>
      {objectLabel || finding.line ? (
        <div className="mt-1 flex flex-wrap items-center gap-2 font-mono text-[10px] text-muted">
          {objectLabel ? <span>{objectLabel}</span> : null}
          {finding.line ? (
            onJumpToLine ? (
              <button
                type="button"
                className="text-ember hover:underline"
                onClick={() => onJumpToLine(finding.line as number)}
              >
                line {finding.line}
              </button>
            ) : (
              <span>line {finding.line}</span>
            )
          ) : null}
        </div>
      ) : null}
      <div className="finding-message">{finding.message}</div>
      {!compact ? (
        <div className="finding-rec">
          <span className="font-semibold text-ink-soft">Fix:</span> {finding.recommendation}
        </div>
      ) : null}
      {!compact && finding.evidence ? (
        <pre className="finding-evidence">{finding.evidence}</pre>
      ) : null}
    </div>
  );
}

export function FindingFilters({
  findings,
  severity,
  category,
  search,
  onSeverity,
  onCategory,
  onSearch,
}: {
  findings: Finding[];
  severity: Severity | 'all';
  category: FindingCategory | 'all';
  search: string;
  onSeverity: (value: Severity | 'all') => void;
  onCategory: (value: FindingCategory | 'all') => void;
  onSearch: (value: string) => void;
}) {
  const counts = severityCounts(findings);
  const categories = Array.from(
    new Set(findings.map((finding) => finding.category)),
  ).sort();
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex flex-wrap items-center gap-1">
        <button
          type="button"
          className={cn(
            'badge cursor-pointer',
            severity === 'all' && 'badge-ember',
          )}
          onClick={() => onSeverity('all')}
        >
          all {findings.length}
        </button>
        {SEVERITY_ORDER.filter((item) => counts[item] > 0).map((item) => (
          <button
            key={item}
            type="button"
            className={cn(
              'badge cursor-pointer',
              severity === item ? `sev-${item}` : 'text-muted',
            )}
            onClick={() => onSeverity(severity === item ? 'all' : item)}
          >
            {item} {counts[item]}
          </button>
        ))}
      </div>
      {categories.length > 1 ? (
        <Combobox
          className="min-w-[150px]"
          buttonClassName="py-1 text-[11px]"
          options={[
            { value: 'all', label: 'All categories' },
            ...categories.map((item) => ({
              value: item,
              label: CATEGORY_LABELS[item],
            })),
          ]}
          value={category}
          onChange={(value) => onCategory(value as FindingCategory | 'all')}
          clearable={false}
          maxHeight={300}
        />
      ) : null}
      <div className="relative ml-auto min-w-[180px]">
        <Search
          size={12}
          className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted"
        />
        <input
          className="input input-search py-1 text-[11px]"
          value={search}
          onChange={(event) => onSearch(event.target.value)}
          placeholder="Filter findings…"
        />
      </div>
    </div>
  );
}

function filterFindings(
  findings: Finding[],
  severity: Severity | 'all',
  category: FindingCategory | 'all',
  search: string,
): Finding[] {
  const needle = search.trim().toLowerCase();
  return findings.filter((finding) => {
    if (severity !== 'all' && finding.severity !== severity) return false;
    if (category !== 'all' && finding.category !== category) return false;
    if (!needle) return true;
    return (
      finding.title.toLowerCase().includes(needle) ||
      finding.message.toLowerCase().includes(needle) ||
      finding.ruleId.toLowerCase().includes(needle) ||
      finding.recommendation.toLowerCase().includes(needle)
    );
  });
}

export function FindingsList({
  findings,
  emptyTitle = 'No findings',
  emptyCopy = 'Nothing to report here.',
  onJumpToLine,
  compact,
  showFilters = true,
}: {
  findings: Finding[];
  emptyTitle?: string;
  emptyCopy?: string;
  onJumpToLine?: (line: number) => void;
  compact?: boolean;
  showFilters?: boolean;
}) {
  const [severity, setSeverity] = useState<Severity | 'all'>('all');
  const [category, setCategory] = useState<FindingCategory | 'all'>('all');
  const [search, setSearch] = useState('');
  const filtered = useMemo(
    () => filterFindings(findings, severity, category, search),
    [findings, severity, category, search],
  );

  if (findings.length === 0) {
    return (
      <EmptyState
        icon={<ShieldAlert size={22} />}
        title={emptyTitle}
        copy={emptyCopy}
      />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {showFilters ? (
        <FindingFilters
          findings={findings}
          severity={severity}
          category={category}
          search={search}
          onSeverity={setSeverity}
          onCategory={setCategory}
          onSearch={setSearch}
        />
      ) : null}
      {filtered.length === 0 ? (
        <EmptyState
          icon={<Filter size={20} />}
          title="No findings match the filters"
          copy="Clear the filters or search for something else."
        />
      ) : (
        <div className="flex flex-col gap-2">
          {filtered.map((finding) => (
            <FindingCard
              key={finding.id}
              finding={finding}
              compact={compact}
              onJumpToLine={onJumpToLine}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function GroupedFindings({
  groups,
  onJumpToLine,
}: {
  groups: FindingGroup[];
  onJumpToLine?: (line: number) => void;
}) {
  const [severity, setSeverity] = useState<Severity | 'all'>('all');
  const [category, setCategory] = useState<FindingCategory | 'all'>('all');
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const allFindings = useMemo(
    () => groups.flatMap((group) => group.instances),
    [groups],
  );
  const needle = search.trim().toLowerCase();
  const filtered = groups.filter((group) => {
    if (severity !== 'all' && group.severity !== severity) return false;
    if (category !== 'all' && group.category !== category) return false;
    if (!needle) return true;
    return (
      group.title.toLowerCase().includes(needle) ||
      group.ruleId.toLowerCase().includes(needle) ||
      group.instances.some((finding) =>
        `${finding.message} ${finding.object?.table ?? ''} ${finding.object?.column ?? ''}`
          .toLowerCase()
          .includes(needle),
      )
    );
  });

  const toggle = (ruleId: string): void => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(ruleId)) next.delete(ruleId);
      else next.add(ruleId);
      return next;
    });
  };

  if (groups.length === 0) {
    return (
      <EmptyState
        icon={<ShieldAlert size={22} />}
        title="No findings"
        copy="This audit did not produce any findings."
      />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <FindingFilters
        findings={allFindings}
        severity={severity}
        category={category}
        search={search}
        onSeverity={setSeverity}
        onCategory={setCategory}
        onSearch={setSearch}
      />
      <div className="flex flex-col gap-2">
        {filtered.map((group) => {
          const open = expanded.has(group.ruleId);
          return (
            <div key={group.ruleId} className="card overflow-hidden">
              <button
                type="button"
                className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-panel-2"
                onClick={() => toggle(group.ruleId)}
              >
                {open ? (
                  <ChevronDown size={14} className="text-muted" />
                ) : (
                  <ChevronRight size={14} className="text-muted" />
                )}
                <SeverityBadge severity={group.severity} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12.5px] font-semibold text-ink">
                    {group.title}
                  </span>
                  <span className="mt-0.5 block font-mono text-[9.5px] text-muted">
                    {group.ruleId} · {CATEGORY_LABELS[group.category]}
                  </span>
                </span>
                <Badge tone="neutral">{group.count}×</Badge>
              </button>
              {open ? (
                <div className="flex flex-col gap-2 border-t border-line-soft p-3">
                  {group.instances.map((finding) => (
                    <div
                      key={finding.id}
                      className="rounded-lg border border-line-soft bg-panel-2/50 p-3"
                    >
                      <div className="flex flex-wrap items-center gap-2 text-[10px] text-muted">
                        {finding.object?.database || finding.object?.table ? (
                          <span className="font-mono">
                            {[finding.object.database, finding.object.table]
                              .filter(Boolean)
                              .join('.')}
                          </span>
                        ) : null}
                        {finding.object?.column ? (
                          <span className="font-mono">.{finding.object.column}</span>
                        ) : null}
                        {finding.object?.index ? (
                          <span className="font-mono">index {finding.object.index}</span>
                        ) : null}
                        {finding.object?.user ? (
                          <span className="font-mono">
                            '{finding.object.user}'@'{finding.object.host}'
                          </span>
                        ) : null}
                      </div>
                      <div className="mt-1 text-[12px] text-ink-soft">{finding.message}</div>
                      <div className="mt-1 text-[11px] text-muted">
                        <span className="font-semibold">Fix:</span> {finding.recommendation}
                      </div>
                    </div>
                  ))}
                  {group.count > group.instances.length ? (
                    <div className="text-[11px] text-muted">
                      … {group.count - group.instances.length} more instance(s) not shown.
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          );
        })}
        {filtered.length === 0 ? (
          <EmptyState icon={<Filter size={20} />} title="No groups match the filters" />
        ) : null}
      </div>
    </div>
  );
}

export function FindingsSummary({ findings }: { findings: Finding[] }) {
  const counts = severityCounts(findings);
  return (
    <div className="flex flex-wrap items-center gap-2">
      {SEVERITY_ORDER.map((severity) =>
        counts[severity] > 0 ? (
          <span key={severity} className={cn('badge', `sev-${severity}`)}>
            {counts[severity]} {severity}
          </span>
        ) : null,
      )}
      {findings.length === 0 ? <Badge tone="mint">clean</Badge> : null}
    </div>
  );
}

export function FindingsHint({ findings }: { findings: Finding[] }) {
  if (findings.length === 0) return null;
  const critical = findings.filter(
    (finding) => finding.severity === 'critical' || finding.severity === 'high',
  ).length;
  return (
    <div className="callout flex items-start gap-2">
      <AlertTriangle size={15} className="mt-0.5 shrink-0 text-ember" />
      <div>
        {critical > 0
          ? `${critical} high-impact finding${critical === 1 ? '' : 's'} need attention before you run this in production.`
          : 'Review the findings below, then verify any rewrite against EXPLAIN.'}
      </div>
    </div>
  );
}
