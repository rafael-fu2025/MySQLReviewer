import { lazy, Suspense, useEffect, useRef } from 'react';
import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { AlertTriangle, Database, RefreshCw } from 'lucide-react';
import { useAppStore } from '@/store/app-store';
import { getApiSessionSnapshot, subscribeSessionSignals } from '@/lib/api';
import { AppShell } from '@/components/AppShell';
import { ToastViewport, Button, Card, Spinner } from '@/components/ui';

const ROUTE_RETRY_DELAY_MS = 180;
const ROUTE_RELOAD_WINDOW_MS = 10_000;

function routeReloadKey(id: string): string {
  return `mylens.routeReload.${id}`;
}

function clearRouteReload(id: string): void {
  try {
    sessionStorage.removeItem(routeReloadKey(id));
  } catch {
    // Storage can be unavailable in private mode; recovery still works.
  }
}

/**
 * Allows one automatic reload per route in a short window. A rebuild removes
 * the old hashed chunk, and the current page must be reloaded to discover the
 * new chunk map; the marker prevents a failure loop if the new build is also
 * unavailable.
 */
function markRouteForReload(id: string): boolean {
  try {
    const key = routeReloadKey(id);
    const previous = Number(sessionStorage.getItem(key));
    if (Number.isFinite(previous) && Date.now() - previous < ROUTE_RELOAD_WINDOW_MS) {
      sessionStorage.removeItem(key);
      return false;
    }
    sessionStorage.setItem(key, String(Date.now()));
    return true;
  } catch {
    return false;
  }
}

async function loadRoute<TModule>(id: string, load: () => Promise<TModule>): Promise<TModule> {
  try {
    const module = await load();
    clearRouteReload(id);
    return module;
  } catch {
    // Chunk fetches can fail transiently while the local server settles.
    await new Promise((resolve) => setTimeout(resolve, ROUTE_RETRY_DELAY_MS));
  }

  try {
    const module = await load();
    clearRouteReload(id);
    return module;
  } catch (error) {
    if (markRouteForReload(id)) {
      window.location.reload();
      // Keep this route suspended while the browser replaces the document.
      await new Promise<never>(() => undefined);
    }
    throw error;
  }
}

const ConnectPage = lazy(() =>
  loadRoute('connect', () =>
    import('@/pages/ConnectPage').then((module) => ({ default: module.ConnectPage })),
  ),
);
const LoginPage = lazy(() =>
  loadRoute('login', () =>
    import('@/pages/LoginPage').then((module) => ({ default: module.LoginPage })),
  ),
);
const AdminPage = lazy(() =>
  loadRoute('admin', () =>
    import('@/pages/AdminPage').then((module) => ({ default: module.AdminPage })),
  ),
);
const WorkspacePage = lazy(() =>
  loadRoute('workspace', () =>
    import('@/pages/WorkspacePage').then((module) => ({ default: module.WorkspacePage })),
  ),
);
const DatabasePage = lazy(() =>
  loadRoute('database', () =>
    import('@/pages/DatabasePage').then((module) => ({ default: module.DatabasePage })),
  ),
);
const PracticePage = lazy(() =>
  loadRoute('practice', () =>
    import('@/pages/PracticePage').then((module) => ({ default: module.PracticePage })),
  ),
);
const PerformancePage = lazy(() =>
  loadRoute('performance', () =>
    import('@/pages/PerformancePage').then((module) => ({ default: module.PerformancePage })),
  ),
);
const SecurityPage = lazy(() =>
  loadRoute('security', () =>
    import('@/pages/SecurityPage').then((module) => ({ default: module.SecurityPage })),
  ),
);
const AuditPage = lazy(() =>
  loadRoute('audit', () =>
    import('@/pages/AuditPage').then((module) => ({ default: module.AuditPage })),
  ),
);
const ReportsPage = lazy(() =>
  loadRoute('reports', () =>
    import('@/pages/ReportsPage').then((module) => ({ default: module.ReportsPage })),
  ),
);
const ReportDetailPage = lazy(() =>
  loadRoute('report-detail', () =>
    import('@/pages/ReportDetailPage').then((module) => ({ default: module.ReportDetailPage })),
  ),
);
const SettingsPage = lazy(() =>
  loadRoute('settings', () =>
    import('@/pages/SettingsPage').then((module) => ({ default: module.SettingsPage })),
  ),
);

function RouteFallback() {
  return (
    <div className="flex h-screen items-center justify-center gap-2 text-xs text-muted">
      <Spinner size={14} />
      Loading…
    </div>
  );
}

function Splash() {
  return (
    <div className="flex h-screen flex-col items-center justify-center gap-5">
      <div className="brand-mark" style={{ width: 54, height: 54, borderRadius: 16 }}>
        <Database size={24} />
      </div>
      <div className="text-center">
        <div className="text-xl font-extrabold tracking-tight">MyLens</div>
        <div className="mt-1 flex items-center justify-center gap-2 text-xs text-muted">
          <Spinner size={13} />
          Connecting to your local MySQL…
        </div>
      </div>
    </div>
  );
}

function BootError({ message }: { message: string }) {
  return (
    <div className="flex h-screen items-center justify-center p-6">
      <Card className="w-full max-w-lg p-6">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-danger/10 text-danger">
            <AlertTriangle size={20} />
          </div>
          <div>
            <div className="text-lg font-bold">The local server is not responding</div>
            <div className="text-xs text-muted">MyLens could not load its bootstrap data.</div>
          </div>
        </div>
        <pre className="code-block mt-4 max-h-40 whitespace-pre-wrap">{message}</pre>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            variant="primary"
            icon={<RefreshCw size={14} />}
            onClick={() => window.location.reload()}
          >
            Retry
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              window.location.href = 'http://127.0.0.1:5174';
            }}
          >
            Open the local server page
          </Button>
        </div>
        <div className="mt-4 text-2xs leading-5 text-muted">
          Start the API with <span className="kbd">npm run dev</span> or{' '}
          <span className="kbd">npm start</span>. In XAMPP, make sure MySQL is running on port 3306.
        </div>
      </Card>
    </div>
  );
}

function RequireConnection() {
  const activeProfileId = useAppStore((state) => state.activeProfileId);
  const server = useAppStore((state) => state.server);
  const location = useLocation();
  if (!activeProfileId || !server) {
    return <Navigate to="/connect" replace state={{ from: location.pathname }} />;
  }
  return <Outlet />;
}

/** Redirects signed-out users to the login page (remembering where they went). */
function RequireAuth() {
  const currentUser = useAppStore((state) => state.currentUser);
  const needsSetup = useAppStore((state) => state.needsSetup);
  const location = useLocation();
  if (!currentUser) {
    return (
      <Navigate to={needsSetup ? '/setup' : '/login'} replace state={{ from: location.pathname }} />
    );
  }
  return <Outlet />;
}

/** Admin-only routes; members bounce back to the workspace. */
function RequireAdmin() {
  const currentUser = useAppStore((state) => state.currentUser);
  if (currentUser?.role !== 'admin') {
    return <Navigate to="/workspace" replace />;
  }
  return <Outlet />;
}

export default function App() {
  const ready = useAppStore((state) => state.ready);
  const bootError = useAppStore((state) => state.bootError);
  const activeProfileId = useAppStore((state) => state.activeProfileId);
  const server = useAppStore((state) => state.server);
  const init = useAppStore((state) => state.init);
  const revalidateSession = useAppStore((state) => state.revalidateSession);
  const handleSessionSignal = useAppStore((state) => state.handleSessionSignal);
  const lastRevalidationRef = useRef(0);

  useEffect(() => {
    void init();
  }, [init]);

  useEffect(() => {
    const revalidate = (immediate = false): void => {
      // Focus and visibility commonly fire together. Collapse that pair without
      // weakening the pageshow/cross-tab backstop.
      const now = Date.now();
      if (!immediate && now - lastRevalidationRef.current < 250) return;
      lastRevalidationRef.current = now;
      void revalidateSession().catch(() => undefined);
    };
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') revalidate();
    };
    const onFocus = (): void => revalidate();
    const onPageShow = (): void => revalidate();
    const unsubscribe = subscribeSessionSignals((signal) => {
      const current = getApiSessionSnapshot();
      if (signal.userId !== current.userId) {
        // Hide and abort synchronously, but leave account stores untouched until
        // bootstrap verifies whether this hint reflects the shared cookie.
        handleSessionSignal(signal.userId);
        return;
      }
      revalidate(true);
    });
    window.addEventListener('focus', onFocus);
    window.addEventListener('pageshow', onPageShow);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      unsubscribe();
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('pageshow', onPageShow);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [handleSessionSignal, revalidateSession]);

  if (!ready) return <Splash />;
  if (bootError) return <BootError message={bootError} />;

  return (
    <>
      <Suspense fallback={<RouteFallback />}>
        <Routes>
          {/* Only the sign-in screens are reachable without a session. */}
          <Route path="/login" element={<LoginPage mode="login" />} />
          <Route path="/setup" element={<LoginPage mode="setup" />} />
          <Route element={<RequireAuth />}>
            {/* Connection management and reports work without an active MySQL
                connection; data-touching screens sit behind RequireConnection. */}
            <Route element={<AppShell />}>
              <Route element={<RequireAdmin />}>
                <Route path="/admin" element={<AdminPage />} />
                <Route path="/reports" element={<ReportsPage />} />
                <Route path="/reports/:id" element={<ReportDetailPage />} />
                <Route path="/settings" element={<SettingsPage />} />
              </Route>
              <Route element={<RequireConnection />}>
                <Route path="/workspace" element={<WorkspacePage />} />
                <Route path="/database" element={<DatabasePage />} />
                <Route path="/practice" element={<PracticePage />} />
                <Route path="/performance" element={<PerformancePage />} />
                <Route path="/security" element={<SecurityPage />} />
                <Route element={<RequireAdmin />}>
                  <Route path="/audit" element={<AuditPage />} />
                </Route>
              </Route>
            </Route>
            <Route path="/connect" element={<ConnectPage />} />
          </Route>
          <Route
            path="*"
            element={
              <Navigate to={activeProfileId && server ? '/workspace' : '/connect'} replace />
            }
          />
        </Routes>
      </Suspense>
      <ToastViewport />
    </>
  );
}
