import { useMemo, useState } from 'react';
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
import { useAppStore } from '@/store/app-store';
import { useUiStore } from '@/store/ui-store';
import { Badge, IconButton, Spinner, cn } from './ui';
import { Tooltip } from './Tooltip';

export function SchemaSidebar({
  onInsert,
  onOpenTable,
  onCloseMobile,
}: {
  onInsert: (name: string) => void;
  onOpenTable?: (table: string) => void;
  onCloseMobile?: () => void;
}) {
  const navigate = useNavigate();
  const objects = useAppStore((state) => state.objects);
  const selectedDatabase = useAppStore((state) => state.selectedDatabase);
  const refreshObjects = useAppStore((state) => state.refreshObjects);
  const schemaCollapsed = useUiStore((state) => state.schemaCollapsed);
  const toggleSchema = useUiStore((state) => state.toggleSchema);
  const [search, setSearch] = useState('');
  const [openTables, setOpenTables] = useState(true);
  const [openViews, setOpenViews] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

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
    try {
      await refreshObjects();
    } finally {
      setRefreshing(false);
    }
  };

  if (schemaCollapsed) {
    const tableCount = objects?.tables.length ?? 0;
    const viewCount = objects?.views.length ?? 0;
    return (
      <aside className="schema-side schema-side-collapsed">
        <div className="schema-rail">
          <Tooltip label="Expand schema" side="right">
            <IconButton
              label="Expand schema"
              nativeTitle={false}
              onClick={toggleSchema}
            >
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
            <IconButton
              label="Refresh schema"
              nativeTitle={false}
              onClick={() => void refresh()}
            >
              {refreshing ? <Spinner size={14} /> : <RefreshCw size={14} />}
            </IconButton>
          </Tooltip>
        </div>
      </aside>
    );
  }

  return (
    <div className="schema-side">
      <div className="flex items-center gap-2 border-b border-line-soft px-3 py-2.5">
        <Database size={14} className="text-ember" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[11.5px] font-semibold">
            {selectedDatabase ?? 'No database'}
          </div>
          <div className="text-[9.5px] text-muted">
            {objects
              ? `${objects.tables.length} tables · ${objects.views.length} views`
              : 'loading schema…'}
          </div>
        </div>
        <Tooltip label="Collapse schema" side="bottom">
          <IconButton
            label="Collapse schema"
            nativeTitle={false}
            onClick={toggleSchema}
          >
            <PanelLeftClose size={13} />
          </IconButton>
        </Tooltip>
        <Tooltip label="Refresh objects" side="bottom">
          <IconButton
            label="Refresh objects"
            nativeTitle={false}
            onClick={() => void refresh()}
          >
            {refreshing ? <Spinner size={13} /> : <RefreshCw size={13} />}
          </IconButton>
        </Tooltip>
        {onCloseMobile ? (
          <IconButton
            label="Close schema"
            className="schema-mobile-close"
            onClick={onCloseMobile}
          >
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
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto pb-3">
        {!selectedDatabase ? (
          <div className="px-3 py-6 text-center text-[11px] text-muted">
            Select a database in the top bar to browse its objects.
          </div>
        ) : !objects ? (
          <div className="flex flex-col gap-2 p-3">
            {Array.from({ length: 8 }).map((_, index) => (
              <div key={index} className="skeleton h-5" />
            ))}
          </div>
        ) : (
          <>
            <div className="tree-section">
              <button
                type="button"
                className="tree-header w-full"
                onClick={() => setOpenTables((value) => !value)}
              >
                {openTables ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                <span>Tables</span>
                <Badge className="ml-auto">{filteredTables.length}</Badge>
              </button>
              {openTables ? (
                <div className="tree-list">
                  {filteredTables.length === 0 ? (
                    <div className="px-2 py-3 text-[10.5px] text-muted">No tables match.</div>
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
                          <span className="tree-rows">
                            {table.rowsEstimate >= 1000
                              ? `${(table.rowsEstimate / 1000).toFixed(1)}k`
                              : table.rowsEstimate}
                          </span>
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
              ) : null}
            </div>

            {objects.views.length > 0 ? (
              <div className="tree-section">
                <button
                  type="button"
                  className="tree-header w-full"
                  onClick={() => setOpenViews((value) => !value)}
                >
                  {openViews ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                  <span>Views</span>
                  <Badge className="ml-auto">{filteredViews.length}</Badge>
                </button>
                {openViews ? (
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
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
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
                      <span className="text-[9px] font-bold text-ember">
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
      </div>
    </div>
  );
}
