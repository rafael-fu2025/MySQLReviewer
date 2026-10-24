import { Fragment, useId, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  Activity,
  Database,
  FileText,
  FlaskConical,
  PanelLeft,
  Play,
  Plus,
  ScanSearch,
  Settings,
  ShieldCheck,
  Terminal,
} from 'lucide-react';
import { useAppStore } from '@/store/app-store';
import { useUiStore } from '@/store/ui-store';
import { emitWorkspace } from '@/lib/events';
import { Kbd, Modal } from './ui';
import { cn } from '@/lib/utils';

interface PaletteItem {
  id: string;
  label: string;
  group: string;
  icon: string;
  path?: string;
  run?: () => void;
}

const ICONS: Record<string, React.ReactNode> = {
  terminal: <Terminal size={14} />,
  database: <Database size={14} />,
  practice: <FlaskConical size={14} />,
  activity: <Activity size={14} />,
  shield: <ShieldCheck size={14} />,
  scan: <ScanSearch size={14} />,
  file: <FileText size={14} />,
  settings: <Settings size={14} />,
  panel: <PanelLeft size={14} />,
  plus: <Plus size={14} />,
  play: <Play size={14} />,
};

export function CommandPalette() {
  const open = useAppStore((state) => state.paletteOpen);
  const setOpen = useAppStore((state) => state.setPaletteOpen);
  const toggleSidebar = useUiStore((state) => state.toggleSidebar);
  const navigate = useNavigate();
  const location = useLocation();
  const [search, setSearch] = useState('');
  const [index, setIndex] = useState(0);
  const listboxId = useId();

  const items = useMemo<PaletteItem[]>(() => {
    const list: PaletteItem[] = [
      {
        id: 'workspace',
        label: 'Workspace',
        group: 'Navigate',
        path: '/workspace',
        icon: 'terminal',
      },
      {
        id: 'database',
        label: 'Database',
        group: 'Navigate',
        path: '/database',
        icon: 'database',
      },
      { id: 'practice', label: 'SQL Lab', group: 'Navigate', path: '/practice', icon: 'practice' },
      {
        id: 'performance',
        label: 'Performance',
        group: 'Navigate',
        path: '/performance',
        icon: 'activity',
      },
      { id: 'security', label: 'Security', group: 'Navigate', path: '/security', icon: 'shield' },
      { id: 'audit', label: 'Audit', group: 'Navigate', path: '/audit', icon: 'scan' },
      { id: 'reports', label: 'Reports', group: 'Navigate', path: '/reports', icon: 'file' },
      { id: 'settings', label: 'Settings', group: 'Navigate', path: '/settings', icon: 'settings' },
      {
        id: 'create-database',
        label: 'Create database',
        group: 'Actions',
        icon: 'plus',
        run: () => navigate('/database?create=1'),
      },
      {
        id: 'toggle-sidebar',
        label: 'Toggle sidebar',
        group: 'Layout',
        icon: 'panel',
        run: () => toggleSidebar(),
      },
    ];
    if (location.pathname === '/workspace') {
      list.push(
        {
          id: 'run',
          label: 'Run current statement',
          group: 'Workspace',
          icon: 'play',
          run: () => emitWorkspace('run'),
        },
        {
          id: 'run-selection',
          label: 'Run selected SQL',
          group: 'Workspace',
          icon: 'play',
          run: () => emitWorkspace('run-selection'),
        },
        {
          id: 'explain',
          label: 'Explain current statement',
          group: 'Workspace',
          icon: 'activity',
          run: () => emitWorkspace('explain'),
        },
        {
          id: 'review',
          label: 'Review current statement',
          group: 'Workspace',
          icon: 'scan',
          run: () => emitWorkspace('review'),
        },
      );
    }
    return list;
  }, [location.pathname, navigate, toggleSidebar]);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return items;
    return items.filter(
      (item) =>
        item.label.toLowerCase().includes(needle) || item.group.toLowerCase().includes(needle),
    );
  }, [items, search]);

  const safeIndex = Math.min(index, Math.max(0, filtered.length - 1));
  const activeItem = filtered[safeIndex];
  const activeOptionId = activeItem ? `${listboxId}-option-${activeItem.id}` : undefined;

  // Reopening the palette starts from an empty query. Adjusting the state while
  // rendering avoids a second render from an effect.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setSearch('');
      setIndex(0);
    }
  }

  // The modal keeps itself mounted through its exit animation, so this
  // component must not unmount the moment `open` goes false.

  const activate = (item: PaletteItem | undefined): void => {
    if (!item) return;
    setOpen(false);
    if (item.path) navigate(item.path);
    else item.run?.();
  };

  return (
    <Modal
      open={open}
      onClose={() => setOpen(false)}
      ariaLabel="Commands"
      header={
        <div className="border-b border-line-soft p-3">
          <input
            className="input border-0 bg-transparent"
            placeholder="Search actions and pages…"
            role="combobox"
            aria-label="Search actions and pages"
            aria-autocomplete="list"
            aria-expanded={true}
            aria-controls={listboxId}
            aria-activedescendant={activeOptionId}
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setIndex(0);
            }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                setIndex((value) => Math.min(filtered.length - 1, value + 1));
              }
              if (event.key === 'ArrowUp') {
                event.preventDefault();
                setIndex((value) => Math.max(0, value - 1));
              }
              if (event.key === 'Enter') {
                activate(filtered[safeIndex]);
              }
            }}
          />
        </div>
      }
      bodyClassName="max-h-[50vh] overflow-auto p-2"
      footerClassName="flex items-center gap-2 border-t border-line-soft px-3 py-2 text-[10px] text-muted"
      footer={
        <>
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd>
          <span>navigate</span>
          <Kbd>Enter</Kbd>
          <span>open</span>
          <Kbd>Esc</Kbd>
          <span>close</span>
        </>
      }
      backdropStyle={{ paddingTop: '12vh' }}
      panelStyle={{ maxWidth: 520 }}
    >
      <div
        role="listbox"
        id={listboxId}
        aria-label="Commands"
        aria-activedescendant={activeOptionId}
      >
        {filtered.map((item, position) => {
          const showGroup = position === 0 || filtered[position - 1].group !== item.group;
          return (
            <Fragment key={item.id}>
              {showGroup ? (
                <div
                  role="presentation"
                  className="px-2.5 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted"
                >
                  {item.group}
                </div>
              ) : null}
              <button
                type="button"
                role="option"
                id={`${listboxId}-option-${item.id}`}
                aria-selected={position === safeIndex}
                className={cn(
                  'flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[12.5px]',
                  position === safeIndex
                    ? 'bg-ember/12 text-ink'
                    : 'text-ink-soft hover:bg-panel-3',
                )}
                onMouseEnter={() => setIndex(position)}
                onClick={() => activate(item)}
              >
                <span className="text-muted">{ICONS[item.icon]}</span>
                <span className="flex-1">{item.label}</span>
              </button>
            </Fragment>
          );
        })}
        {filtered.length === 0 ? (
          <div className="px-3 py-6 text-center text-[12px] text-muted">
            No action matches “{search.trim()}”.
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
