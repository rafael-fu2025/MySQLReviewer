import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  Activity,
  Command,
  Database,
  FileText,
  FlaskConical,
  Lock,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  ScanSearch,
  Settings,
  ShieldCheck,
  Sparkles,
  Sun,
  Terminal,
  Unlock,
} from 'lucide-react';
import { useAppStore } from '@/store/app-store';
import { useUiStore } from '@/store/ui-store';
import { APP_VERSION } from '@shared/types';
import { formatBytes } from '@/lib/format';
import { Badge, Button, IconButton, Kbd, Spinner } from './ui';
import { cn } from '@/lib/utils';
import { useNow } from '@/lib/hooks';
import { Combobox } from './Combobox';
import { CommandPalette } from './CommandPalette';
import { BottomNav } from './BottomNav';
import { Tooltip } from './Tooltip';

const NAV = [
  { to: '/workspace', label: 'Workspace', icon: Terminal, primary: true },
  { to: '/database', label: 'Database', icon: Database, primary: true },
  { to: '/practice', label: 'SQL Lab', icon: FlaskConical, primary: true },
  { to: '/performance', label: 'Performance', icon: Activity, primary: false },
  { to: '/security', label: 'Security', icon: ShieldCheck, primary: false },
  { to: '/audit', label: 'Audit', icon: ScanSearch, primary: true },
  { to: '/reports', label: 'Reports', icon: FileText, primary: false },
  { to: '/settings', label: 'Settings', icon: Settings, primary: false },
];

const PAGE_META: Record<string, { title: string; sub: string }> = {
  '/workspace': {
    title: 'Workspace',
    sub: 'Write, run, explain, and review SQL with server-side safety guards.',
  },
  '/database': {
    title: 'Database',
    sub: 'Schemas, tables, indexes, relationships, and definitions.',
  },
  '/practice': {
    title: 'SQL Lab',
    sub: 'Reviewer-style challenges generated from your schema. Answer, compare, and learn.',
  },
  '/performance': {
    title: 'Performance',
    sub: 'Live server telemetry, processes, slow queries, and variables.',
  },
  '/security': {
    title: 'Security',
    sub: 'Accounts, grants, authentication plugins, and configuration risk.',
  },
  '/audit': {
    title: 'Audit',
    sub: 'A full deterministic review with transparent coverage.',
  },
  '/reports': {
    title: 'Reports',
    sub: 'Saved audits and AI-assisted reviews.',
  },
  '/settings': {
    title: 'Settings',
    sub: 'Connections, AI providers, review behavior, and appearance.',
  },
};

/**
 * Routes whose page renders its own heading. Those pages state their name and
 * their description once, in the body, so the top bar does not repeat them
 * with a second, slightly different wording. On a phone the duplicate block
 * cost about a tenth of the viewport.
 */
const SELF_TITLED_ROUTES = new Set([
  '/practice',
  '/performance',
  '/security',
  '/audit',
  '/reports',
  '/settings',
]);

function formatCountdown(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function useIsNarrow(): boolean {
  const [narrow, setNarrow] = useState(() =>
    typeof window === 'undefined' ? false : window.matchMedia('(max-width: 900px)').matches,
  );
  useEffect(() => {
    const media = window.matchMedia('(max-width: 900px)');
    const onChange = (): void => setNarrow(media.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);
  return narrow;
}

export function AppShell() {
  const navigate = useNavigate();
  const location = useLocation();
  const server = useAppStore((state) => state.server);
  const profiles = useAppStore((state) => state.profiles);
  const activeProfileId = useAppStore((state) => state.activeProfileId);
  const databases = useAppStore((state) => state.databases);
  const selectedDatabase = useAppStore((state) => state.selectedDatabase);
  const setDatabase = useAppStore((state) => state.setDatabase);
  const unlockedUntil = useAppStore((state) => state.unlockedUntil);
  const lockWrites = useAppStore((state) => state.lockWrites);
  const refreshDatabases = useAppStore((state) => state.refreshDatabases);
  const refreshSchema = useAppStore((state) => state.refreshSchema);
  const refreshObjects = useAppStore((state) => state.refreshObjects);
  const providers = useAppStore((state) => state.providers);
  const theme = useAppStore((state) => state.theme);
  const setTheme = useAppStore((state) => state.setTheme);
  const setPaletteOpen = useAppStore((state) => state.setPaletteOpen);
  const version = useAppStore((state) => state.boot?.version ?? APP_VERSION);
  const now = useNow(1000);
  const [refreshing, setRefreshing] = useState(false);
  const narrow = useIsNarrow();
  const sidebarCollapsed = useUiStore((state) => state.sidebarCollapsed);
  const toggleSidebar = useUiStore((state) => state.toggleSidebar);
  const compactSidebar = sidebarCollapsed || narrow;

  const activeProfile = profiles.find((profile) => profile.id === activeProfileId);
  const scoped = activeProfile?.databaseScope === 'selected';
  const hideServerWide = Boolean(scoped && !activeProfile?.allowServerWideInsights);
  const navItems = NAV.filter(
    (item) => !(hideServerWide && (item.to === '/performance' || item.to === '/security')),
  );
  const primaryNav = navItems.filter((item) => item.primary);
  const overflowNav = navItems.filter((item) => !item.primary);
  const defaultProvider = providers.find((provider) => provider.isDefault);
  const meta =
    PAGE_META[location.pathname] ??
    (location.pathname.startsWith('/reports/')
      ? { title: 'Report', sub: 'Saved audit details and exports.' }
      : { title: 'MyLens', sub: '' });
  const showMeta = !SELF_TITLED_ROUTES.has(location.pathname);

  const unlocked = Boolean(unlockedUntil && unlockedUntil > now);
  const remaining = unlockedUntil ? unlockedUntil - now : 0;

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setPaletteOpen]);

  const refreshAll = async (): Promise<void> => {
    setRefreshing(true);
    try {
      await refreshDatabases();
      await refreshSchema(true);
      await refreshObjects();
    } finally {
      setRefreshing(false);
    }
  };

  const userDatabases = databases.filter((database) => !database.isSystem);
  const systemDatabases = databases.filter((database) => database.isSystem);
  const databaseOptions = [
    ...userDatabases.map((database) => ({
      value: database.name,
      label: database.name,
      description: `${database.tableCount} tables · ${formatBytes(database.sizeBytes)}`,
      group: 'Databases',
    })),
    ...systemDatabases.map((database) => ({
      value: database.name,
      label: database.name,
      description: 'system schema',
      group: 'System',
    })),
  ];

  return (
    <div className="app-shell">
      <aside className={cn('sidebar', sidebarCollapsed && 'sidebar-collapsed')}>
        <div
          className="brand"
          role="button"
          tabIndex={0}
          onClick={() => navigate('/workspace')}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              navigate('/workspace');
            }
          }}
        >
          <div className="brand-mark">
            <Terminal size={19} />
          </div>
          <div className="brand-copy">
            <div className="brand-title">MyLens</div>
          </div>
          <Tooltip
            label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            side="right"
            className="brand-toggle"
          >
            <IconButton
              label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              nativeTitle={false}
              onClick={(event) => {
                event.stopPropagation();
                toggleSidebar();
              }}
            >
              {sidebarCollapsed ? <PanelLeftOpen size={15} /> : <PanelLeftClose size={15} />}
            </IconButton>
          </Tooltip>
          <div className="brand-sub">MySQL Review Studio</div>
        </div>

        <Tooltip
          label={
            activeProfile
              ? `${activeProfile.name}${server ? ` · ${server.version}` : ''} · click to switch`
              : 'Choose a connection'
          }
          side="right"
          block
          disabled={!compactSidebar}
        >
          <div
            className="connection-card"
            role="button"
            tabIndex={0}
            onClick={() => navigate('/connect')}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                navigate('/connect');
              }
            }}
          >
            <div className="connection-name">
              <span className="connection-glyph">
                <Database size={13} />
                <span className={cn('status-dot', !server && 'off')} />
              </span>
              <span className="connection-copy truncate">
                {activeProfile?.name ?? 'No connection'}
              </span>
            </div>
            <div className="connection-meta">
              {server
                ? `${server.version} · ${scoped ? `${activeProfile?.allowedDatabases.length ?? 0} DB scope` : 'all databases'}`
                : 'Click to choose a connection'}
            </div>
          </div>
        </Tooltip>

        <nav className="nav">
          <div className="nav-label">Explore</div>
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <Tooltip
                key={item.to}
                label={item.label}
                side="right"
                block
                disabled={!compactSidebar}
              >
                <NavLink
                  to={item.to}
                  aria-label={item.label}
                  className={({ isActive }) => cn('nav-item', isActive && 'active')}
                >
                  <Icon size={16} />
                  <span>{item.label}</span>
                </NavLink>
              </Tooltip>
            );
          })}
        </nav>

        <div className="sidebar-footer">
          <Tooltip
            label={defaultProvider ? `AI · ${defaultProvider.name}` : 'Add provider'}
            side="right"
            block
            disabled={!compactSidebar}
          >
            <button
              type="button"
              className="nav-item w-full"
              onClick={() => navigate('/settings?tab=ai')}
            >
              <Sparkles size={16} className={defaultProvider ? 'text-ember' : ''} />
              <span className="truncate">
                {defaultProvider ? defaultProvider.name : 'Add provider'}
              </span>
              {defaultProvider ? (
                <span className="nav-badge">
                  {defaultProvider.model.split('/').pop()?.slice(0, 10)}
                </span>
              ) : null}
            </button>
          </Tooltip>
          <div className="flex items-center justify-between px-1">
            <span className="text-[10px] text-muted hide-collapse">v{version} · local</span>
            <Tooltip
              label={theme === 'light' ? 'Switch to dark theme' : 'Switch to light theme'}
              side="top"
            >
              <IconButton
                label={theme === 'light' ? 'Switch to dark theme' : 'Switch to light theme'}
                nativeTitle={false}
                onClick={() => void setTheme(theme === 'light' ? 'dark' : 'light')}
              >
                {theme === 'light' ? <Moon size={15} /> : <Sun size={15} />}
              </IconButton>
            </Tooltip>
          </div>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          {showMeta ? (
            <div className="min-w-0 flex-1">
              <div className="topbar-title">{meta.title}</div>
              <div className="topbar-sub truncate">{meta.sub}</div>
            </div>
          ) : (
            // The page states its own heading, so the bar holds only the
            // global controls. The spacer keeps them right-aligned.
            <div className="min-w-0 flex-1" aria-hidden="true" />
          )}

          <Combobox
            options={databaseOptions}
            value={selectedDatabase}
            onChange={(value) => {
              if (value) setDatabase(value);
            }}
            placeholder="Select database…"
            className="order-last w-full basis-full md:order-none md:w-[190px] md:basis-auto xl:w-[230px]"
            buttonClassName="py-1.5 text-[11.5px]"
            clearable={false}
            maxHeight={360}
          />

          {scoped ? (
            <Badge tone="ember" className="hidden sm:inline-flex">
              {activeProfile?.allowedDatabases.length ?? 0} DB scope
            </Badge>
          ) : null}

          <button
            type="button"
            className={cn('badge cursor-pointer', unlocked ? 'sev-medium' : 'text-muted')}
            onClick={() => {
              if (unlocked) void lockWrites();
            }}
            title={unlocked ? 'Lock writes now' : undefined}
          >
            {unlocked ? <Unlock size={11} /> : <Lock size={11} />}
            <span className="hidden md:inline">
              {unlocked ? `Unlocked ${formatCountdown(remaining)}` : 'Read-only'}
            </span>
          </button>

          <IconButton label="Refresh schema" onClick={() => void refreshAll()}>
            {refreshing ? <Spinner size={15} /> : <RefreshCw size={15} />}
          </IconButton>

          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => setPaletteOpen(true)}
          >
            <Command size={13} />
            <span className="hidden md:inline">Commands</span>
            <span className="hidden md:inline-flex">
              <Kbd>Ctrl K</Kbd>
            </span>
          </button>
        </header>

        {unlocked ? (
          <div className="px-4 pt-3">
            <div className="callout danger flex flex-wrap items-center gap-2">
              <Unlock size={14} className="text-danger" />
              <span className="font-semibold text-ink">
                Writes are unlocked for {formatCountdown(remaining)}.
              </span>
              <Button
                variant="danger"
                size="sm"
                className="ml-auto"
                icon={<Lock size={12} />}
                onClick={() => void lockWrites()}
              >
                Lock now
              </Button>
            </div>
          </div>
        ) : null}

        <div className={cn('content', location.pathname === '/workspace' && 'flush')}>
          <Outlet />
        </div>
      </main>

      <BottomNav
        items={primaryNav}
        overflow={overflowNav}
        aiLabel={defaultProvider ? defaultProvider.name : 'Add provider'}
        aiActive={Boolean(defaultProvider)}
        theme={theme}
        onToggleTheme={() => void setTheme(theme === 'light' ? 'dark' : 'light')}
      />

      <CommandPalette />
    </div>
  );
}
