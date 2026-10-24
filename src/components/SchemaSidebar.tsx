import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ChevronDown,
  ChevronRight,
  Database,
  ExternalLink,
  Eye,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  Search,
  Table2,
  X,
} from 'lucide-react';
import type { ColumnInfo, DatabaseObjects } from '@shared/types';
import { loadObjects, useAppStore } from '@/store/app-store';
import { useUiStore } from '@/store/ui-store';
import { dbApi } from '@/lib/db-api';
import { cn } from '@/lib/utils';
import { Badge, IconButton, Spinner } from './ui';
import { Tooltip } from './Tooltip';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './ui/collapsible';
import { ScrollArea } from './ui/scroll-area';

export interface SchemaSidebarProps {
  onInsert: (name: string) => void;
  onOpenTable?: (table: string) => void;
  onCloseMobile?: () => void;
  /**
   * Pin the tree to a database that may differ from the top-bar selection.
   * When omitted, the sidebar follows `selectedDatabase` exactly as before.
   */
  database?: string | null;
  /** Connection used to load a pinned database. Required when `database` is pinned. */
  profileId?: string | null;
  className?: string;
  variant?: 'sidebar' | 'panel';
  /**
   * Panel variant only: hug the content instead of filling the column, and
   * scroll the tree inside a bounded box. Used where the panel sits next to a
   * taller column and must not stretch to match it.
   */
  compact?: boolean;
  /** Maximum height of the scrollable tree in the compact panel variant. */
  treeMaxHeight?: string;
  /** Renders a compact "Preview 5 rows" action next to each table. */
  onPreviewTable?: (table: string) => void;
}

type ColumnState = ColumnInfo[] | 'loading' | 'error';

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function quoteIdentifier(name: string): string {
  return `\`${name.replace(/`/g, '``')}\``;
}

function formatRows(rows: number): string {
  return rows >= 1000 ? `${(rows / 1000).toFixed(1)}k` : String(rows);
}

export function SchemaSidebar({
  onInsert,
  onOpenTable,
  onCloseMobile,
  database = null,
  profileId = null,
  className,
  variant = 'sidebar',
  compact = false,
  treeMaxHeight = '320px',
  onPreviewTable,
}: SchemaSidebarProps) {
  const navigate = useNavigate();
  const isPanel = variant === 'panel';
  const storeObjects = useAppStore((state) => state.objects);
  const selectedDatabase = useAppStore((state) => state.selectedDatabase);
  const refreshObjects = useAppStore((state) => state.refreshObjects);
  const schemaCollapsed = useUiStore((state) => state.schemaCollapsed);
  const toggleSchema = useUiStore((state) => state.toggleSchema);
  const [search, setSearch] = useState('');
  const [openTables, setOpenTables] = useState(true);
  const [openViews, setOpenViews] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [pinnedObjects, setPinnedObjects] = useState<DatabaseObjects | null>(null);
  const [pinnedError, setPinnedError] = useState<string | null>(null);
  // The connection + database pair the pinned objects were fetched for.
  const [pinnedSettledKey, setPinnedSettledKey] = useState<string | null>(null);
  const [expandedTables, setExpandedTables] = useState<Record<string, boolean>>({});
  const [columns, setColumns] = useState<Record<string, ColumnState>>({});

  const pinnedDatabase = database && database.length > 0 ? database : null;
  const activeDatabase = pinnedDatabase ?? selectedDatabase;
  // Only bypass the store when the pinned database is a different one. Reading
  // `objects` for the selected database keeps the two views in sync.
  const usesPinnedFetch = pinnedDatabase !== null && pinnedDatabase !== selectedDatabase;
  const objects = usesPinnedFetch ? pinnedObjects : storeObjects;
  // The pinned fetch belongs to one connection + database pair.
  const pinnedKey =
    usesPinnedFetch && pinnedDatabase && profileId ? `${profileId}\u0000${pinnedDatabase}` : null;

  // Never show the previous database's objects while the new one loads. The
  // reset happens while rendering so the stale tree is never painted.
  const [pinnedKeyState, setPinnedKeyState] = useState<string | null>(null);
  if (pinnedKeyState !== pinnedKey) {
    setPinnedKeyState(pinnedKey);
    setPinnedObjects(null);
    setPinnedError(null);
  }
  // Loading is derived: it lasts until the pinned fetch for this key settles.
  const pinnedLoading = pinnedKey !== null && pinnedSettledKey !== pinnedKey;

  useEffect(() => {
    if (!pinnedKey || !pinnedDatabase || !profileId) return;
    let cancelled = false;
    loadObjects(profileId, pinnedDatabase)
      .then((next) => {
        if (cancelled) return;
        setPinnedObjects(next);
        setPinnedError(null);
        setPinnedSettledKey(pinnedKey);
      })
      .catch((error) => {
        if (cancelled) return;
        setPinnedError(errorMessage(error));
        setPinnedSettledKey(pinnedKey);
      });
    return () => {
      cancelled = true;
    };
  }, [pinnedKey, pinnedDatabase, profileId]);

  // Column caches belong to one database; drop them when the tree retargets.
  const [cachedDatabase, setCachedDatabase] = useState(activeDatabase);
  if (cachedDatabase !== activeDatabase) {
    setCachedDatabase(activeDatabase);
    setExpandedTables({});
    setColumns({});
  }

  const filteredTables = useMemo(() => {
    const tables = objects?.tables ?? [];
    const needle = search.trim().toLowerCase();
    if (!needle) return tables;
    return tables.filter((table) => table.name.toLowerCase().includes(needle));
  }, [objects?.tables, search]);

  const filteredViews = useMemo(() => {
    const views = objects?.views ?? [];
    const needle = search.trim().toLowerCase();
    if (!needle) return views;
    return views.filter((view) => view.name.toLowerCase().includes(needle));
  }, [objects?.views, search]);

  const openObject = (name: string): void => {
    if (onOpenTable) {
      onOpenTable(name);
      return;
    }
    navigate(`/database?table=${encodeURIComponent(name)}`);
  };

  const refresh = async (): Promise<void> => {
    setRefreshing(true);
    if (usesPinnedFetch) {
      if (!pinnedDatabase || !profileId) {
        setRefreshing(false);
        return;
      }
      setPinnedError(null);
      try {
        setPinnedObjects(await loadObjects(profileId, pinnedDatabase));
      } catch (error) {
        setPinnedError(errorMessage(error));
      } finally {
        setRefreshing(false);
      }
      return;
    }
    try {
      await refreshObjects();
    } finally {
      setRefreshing(false);
    }
  };

  const loadColumns = async (table: string): Promise<void> => {
    if (!profileId || !activeDatabase) return;
    if (columns[table]) return;
    setColumns((previous) => ({ ...previous, [table]: 'loading' }));
    try {
      const detail = await dbApi.tableDetail(profileId, activeDatabase, table);
      setColumns((previous) => ({ ...previous, [table]: detail.columns }));
    } catch {
      setColumns((previous) => ({ ...previous, [table]: 'error' }));
    }
  };

  const toggleTable = (table: string): void => {
    const next = !expandedTables[table];
    setExpandedTables((previous) => ({ ...previous, [table]: next }));
    if (next) void loadColumns(table);
  };

  const renderColumns = (table: string): ReactNode => {
    const state = columns[table];
    if (!state || state === 'loading') {
      return <div className="px-2 py-1 text-[10px] text-muted">Loading columns…</div>;
    }
    if (state === 'error') {
      return <div className="px-2 py-1 text-[10px] text-muted">Columns unavailable.</div>;
    }
    if (state.length === 0) {
      return <div className="px-2 py-1 text-[10px] text-muted">No columns.</div>;
    }
    return state.map((column) => (
      <button
        key={column.name}
        type="button"
        className="flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-[10.5px] text-muted transition hover:bg-panel-3 hover:text-ink"
        title={`Insert ${quoteIdentifier(column.name)} · ${column.dataType}`}
        onClick={() => onInsert(quoteIdentifier(column.name))}
      >
        {column.key === 'PRI' ? (
          <span className="shrink-0 rounded bg-ember/15 px-1 text-[10px] font-bold text-ember">
            PK
          </span>
        ) : (
          <span className="w-[18px] shrink-0" />
        )}
        <span className="truncate text-ink-soft">{column.name}</span>
        <span className="ml-auto shrink-0 font-mono text-[10px] text-muted">{column.dataType}</span>
      </button>
    ));
  };

  if (!isPanel && schemaCollapsed) {
    const tableCount = storeObjects?.tables.length ?? 0;
    const viewCount = storeObjects?.views.length ?? 0;
    return (
      <aside className="schema-side schema-side-collapsed">
        <div className="schema-rail">
          <Tooltip label="Expand schema" side="right">
            <IconButton label="Expand schema" nativeTitle={false} onClick={toggleSchema}>
              <PanelLeftOpen size={14} />
            </IconButton>
          </Tooltip>
          <div className="schema-rail-divider" />
          <Tooltip label={`Tables · ${tableCount}`} side="right">
            <button
              type="button"
              className="schema-rail-stat"
              aria-label={`Show ${tableCount} tables`}
              onClick={toggleSchema}
            >
              <Table2 size={15} />
              <span>{tableCount}</span>
            </button>
          </Tooltip>
          <Tooltip label={`Views · ${viewCount}`} side="right">
            <button
              type="button"
              className="schema-rail-stat"
              aria-label={`Show ${viewCount} views`}
              onClick={toggleSchema}
            >
              <Eye size={15} />
              <span>{viewCount}</span>
            </button>
          </Tooltip>
          <div className="schema-rail-spacer" />
          <Tooltip label="Refresh schema" side="right">
            <IconButton label="Refresh schema" nativeTitle={false} onClick={() => void refresh()}>
              {refreshing ? <Spinner size={14} /> : <RefreshCw size={14} />}
            </IconButton>
          </Tooltip>
        </div>
      </aside>
    );
  }

  const summary =
    pinnedLoading && !objects
      ? 'loading schema…'
      : pinnedError
        ? 'could not load objects'
        : objects
          ? `${objects.tables.length} tables · ${objects.views.length} views`
          : 'loading schema…';

  const tree = (
    <>
      {!activeDatabase ? (
        <div className="px-3 py-6 text-center text-[11px] text-muted">
          {isPanel
            ? 'This challenge set has no database to browse.'
            : 'Select a database in the top bar to browse its objects.'}
        </div>
      ) : pinnedError ? (
        <div className="flex flex-col items-start gap-2 p-3">
          <div className="text-[10.5px] text-danger">{pinnedError}</div>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => void refresh()}>
            Retry
          </button>
        </div>
      ) : !objects ? (
        <div className="flex flex-col gap-2 p-3">
          {Array.from({ length: 8 }).map((_, index) => (
            <div key={index} className="skeleton h-5" />
          ))}
        </div>
      ) : (
        <>
          <Collapsible open={openTables} onOpenChange={setOpenTables}>
            <div className="tree-section">
              <CollapsibleTrigger className="tree-header w-full">
                {openTables ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                <span>Tables</span>
                <Badge className="ml-auto">{filteredTables.length}</Badge>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div className="tree-list">
                  {filteredTables.length === 0 ? (
                    <div className="px-2 py-3 text-[10.5px] text-muted">No tables match.</div>
                  ) : isPanel ? (
                    filteredTables.slice(0, 400).map((table) => {
                      const expanded = Boolean(expandedTables[table.name]);
                      return (
                        <div key={table.name}>
                          <div className="tree-item group">
                            {/*
                              In a challenge the table name is a reference, not
                              something to paste, so the name opens the columns
                              instead of inserting it. The columns themselves
                              still insert when tapped.
                            */}
                            <button
                              type="button"
                              className="flex min-w-0 flex-1 items-center gap-1.5 text-left transition hover:text-ink"
                              aria-expanded={expanded}
                              title={`${expanded ? 'Collapse' : 'Expand'} ${table.name}`}
                              onClick={() => toggleTable(table.name)}
                            >
                              {expanded ? (
                                <ChevronDown size={11} className="-ml-1 shrink-0 text-muted" />
                              ) : (
                                <ChevronRight size={11} className="-ml-1 shrink-0 text-muted" />
                              )}
                              <Table2 size={12} className="shrink-0 text-muted" />
                              <span className="truncate">{table.name}</span>
                            </button>
                            {table.rowsEstimate > 0 ? (
                              <span className="tree-rows">{formatRows(table.rowsEstimate)}</span>
                            ) : null}
                            {onPreviewTable ? (
                              <button
                                type="button"
                                className="shrink-0 rounded px-1 py-0.5 text-[10px] text-muted opacity-60 transition hover:bg-panel-3 hover:text-ember focus-visible:opacity-100 group-hover:opacity-100"
                                title={`Preview 5 rows of ${table.name}`}
                                onClick={() => onPreviewTable(table.name)}
                              >
                                Preview 5 rows
                              </button>
                            ) : null}
                            {onOpenTable ? (
                              <button
                                type="button"
                                className="ml-1 shrink-0 rounded p-0.5 text-muted opacity-0 transition hover:bg-panel-3 hover:text-ink group-hover:opacity-100"
                                title="Open table details"
                                onClick={() => openObject(table.name)}
                              >
                                <ExternalLink size={10} />
                              </button>
                            ) : null}
                          </div>
                          {expanded ? (
                            <div className="mb-1 ml-5 border-l border-line-soft pb-0.5 pl-1.5">
                              {renderColumns(table.name)}
                            </div>
                          ) : null}
                        </div>
                      );
                    })
                  ) : (
                    filteredTables.slice(0, 400).map((table) => (
                      <div
                        key={table.name}
                        className="tree-item group"
                        onClick={() => onInsert(table.name)}
                        title={`Insert ${table.name} · click the arrow to open details`}
                      >
                        <Table2 size={12} className="shrink-0 text-muted" />
                        <span>{table.name}</span>
                        {table.rowsEstimate > 0 ? (
                          <span className="tree-rows">{formatRows(table.rowsEstimate)}</span>
                        ) : null}
                        <button
                          type="button"
                          className={cn(
                            'ml-1 rounded p-0.5 text-muted opacity-0 transition hover:bg-panel-3 hover:text-ink group-hover:opacity-100',
                          )}
                          title="Open table details"
                          onClick={(event) => {
                            event.stopPropagation();
                            openObject(table.name);
                          }}
                        >
                          <ExternalLink size={10} />
                        </button>
                      </div>
                    ))
                  )}
                  {filteredTables.length > 400 ? (
                    <div className="px-2 py-2 text-[10px] text-muted">
                      Showing the first 400 objects. Refine the search.
                    </div>
                  ) : null}
                </div>
              </CollapsibleContent>
            </div>
          </Collapsible>

          {objects.views.length > 0 ? (
            <Collapsible open={openViews} onOpenChange={setOpenViews}>
              <div className="tree-section">
                <CollapsibleTrigger className="tree-header w-full">
                  {openViews ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                  <span>Views</span>
                  <Badge className="ml-auto">{filteredViews.length}</Badge>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div className="tree-list">
                    {filteredViews.map((view) => (
                      <div
                        key={view.name}
                        className="tree-item group"
                        onClick={() => onInsert(view.name)}
                        title={`Insert ${view.name}`}
                      >
                        <Eye size={12} className="shrink-0 text-muted" />
                        <span>{view.name}</span>
                        {onOpenTable ? (
                          <button
                            type="button"
                            className="ml-auto rounded p-0.5 text-muted opacity-0 transition hover:bg-panel-3 hover:text-ink group-hover:opacity-100"
                            title="Open view definition"
                            onClick={(event) => {
                              event.stopPropagation();
                              openObject(view.name);
                            }}
                          >
                            <ExternalLink size={10} />
                          </button>
                        ) : null}
                      </div>
                    ))}
                  </div>
                </CollapsibleContent>
              </div>
            </Collapsible>
          ) : null}

          {objects.routines.length > 0 ? (
            <div className="tree-section">
              <div className="tree-header">
                <span>Routines</span>
                <Badge className="ml-auto">{objects.routines.length}</Badge>
              </div>
              <div className="tree-list">
                {objects.routines.slice(0, 30).map((routine) => (
                  <div
                    key={`${routine.type}-${routine.name}`}
                    className="tree-item"
                    onClick={() =>
                      navigate(
                        `/database?object=${encodeURIComponent(routine.name)}&routineType=${routine.type}`,
                      )
                    }
                    title={`${routine.type} ${routine.name}`}
                  >
                    <span className="text-[10px] font-bold text-ember">
                      {routine.type === 'FUNCTION' ? 'FN' : 'PR'}
                    </span>
                    <span>{routine.name}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </>
      )}
    </>
  );

  return (
    <div
      className={cn(
        isPanel
          ? cn('flex h-full min-h-0 flex-col overflow-hidden', compact && 'h-auto')
          : 'schema-side',
        className,
      )}
    >
      <div className="flex items-center gap-2 border-b border-line-soft px-3 py-2.5">
        <Database size={14} className="text-ember" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[11.5px] font-semibold">
              {activeDatabase ?? 'No database'}
            </span>
            {usesPinnedFetch ? <Badge tone="ember">pinned</Badge> : null}
          </div>
          <div className="truncate text-[10px] text-muted">{summary}</div>
        </div>
        <Tooltip label="Refresh objects" side="bottom">
          <IconButton label="Refresh objects" nativeTitle={false} onClick={() => void refresh()}>
            {refreshing ? <Spinner size={13} /> : <RefreshCw size={13} />}
          </IconButton>
        </Tooltip>
        {!isPanel ? (
          <Tooltip label="Collapse schema" side="bottom">
            <IconButton label="Collapse schema" nativeTitle={false} onClick={toggleSchema}>
              <PanelLeftClose size={13} />
            </IconButton>
          </Tooltip>
        ) : null}
        {!isPanel && onCloseMobile ? (
          <IconButton label="Close schema" className="schema-mobile-close" onClick={onCloseMobile}>
            <X size={13} />
          </IconButton>
        ) : null}
      </div>

      <div className="p-2">
        <div className="relative">
          <Search
            size={12}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted"
          />
          <input
            className="input input-search py-1.5 text-[11px]"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Filter tables and views…"
            aria-label="Filter tables and views"
          />
        </div>
      </div>

      {isPanel ? (
        compact ? (
          <div className="overflow-auto pb-3" style={{ maxHeight: treeMaxHeight }}>
            {tree}
          </div>
        ) : (
          <ScrollArea className="min-h-0 flex-1">
            <div className="pb-3">{tree}</div>
          </ScrollArea>
        )
      ) : (
        <div className="min-h-0 flex-1 overflow-auto pb-3">{tree}</div>
      )}
    </div>
  );
}
