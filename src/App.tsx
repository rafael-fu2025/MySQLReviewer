import { lazy, Suspense, useEffect } from 'react';
import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { AlertTriangle, Database, RefreshCw } from 'lucide-react';
import { useAppStore } from '@/store/app-store';
import { AppShell } from '@/components/AppShell';
import { ToastViewport, Button, Card, Spinner } from '@/components/ui';

const ConnectPage = lazy(() =>
  import('@/pages/ConnectPage').then((module) => ({ default: module.ConnectPage })),
);
const WorkspacePage = lazy(() =>
  import('@/pages/WorkspacePage').then((module) => ({ default: module.WorkspacePage })),
);
const DatabasePage = lazy(() =>
  import('@/pages/DatabasePage').then((module) => ({ default: module.DatabasePage })),
);
const PracticePage = lazy(() =>
  import('@/pages/PracticePage').then((module) => ({ default: module.PracticePage })),
);
const PerformancePage = lazy(() =>
  import('@/pages/PerformancePage').then((module) => ({ default: module.PerformancePage })),
);
const SecurityPage = lazy(() =>
  import('@/pages/SecurityPage').then((module) => ({ default: module.SecurityPage })),
);
const AuditPage = lazy(() =>
  import('@/pages/AuditPage').then((module) => ({ default: module.AuditPage })),
);
const ReportsPage = lazy(() =>
  import('@/pages/ReportsPage').then((module) => ({ default: module.ReportsPage })),
);
const ReportDetailPage = lazy(() =>
  import('@/pages/ReportDetailPage').then((module) => ({ default: module.ReportDetailPage })),
);
const SettingsPage = lazy(() =>
  import('@/pages/SettingsPage').then((module) => ({ default: module.SettingsPage })),
);

function RouteFallback() {
  return (
    <div className="flex h-screen items-center justify-center gap-2 text-[12px] text-muted">
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
        <div className="text-[20px] font-extrabold tracking-tight">MyLens</div>
        <div className="mt-1 flex items-center justify-center gap-2 text-[12px] text-muted">
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
            <div className="text-[16px] font-bold">The local server is not responding</div>
            <div className="text-[12px] text-muted">MyLens could not load its bootstrap data.</div>
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
            Open dev UI
          </Button>
        </div>
        <div className="mt-4 text-[11px] leading-5 text-muted">
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

export default function App() {
  const ready = useAppStore((state) => state.ready);
  const bootError = useAppStore((state) => state.bootError);
  const activeProfileId = useAppStore((state) => state.activeProfileId);
  const server = useAppStore((state) => state.server);
  const init = useAppStore((state) => state.init);

  useEffect(() => {
    void init();
  }, [init]);

  if (!ready) return <Splash />;
  if (bootError) return <BootError message={bootError} />;

  return (
    <>
      <Suspense fallback={<RouteFallback />}>
        <Routes>
          <Route path="/connect" element={<ConnectPage />} />
          <Route element={<RequireConnection />}>
            <Route element={<AppShell />}>
              <Route path="/workspace" element={<WorkspacePage />} />
              <Route path="/database" element={<DatabasePage />} />
              <Route path="/practice" element={<PracticePage />} />
              <Route path="/performance" element={<PerformancePage />} />
              <Route path="/security" element={<SecurityPage />} />
              <Route path="/audit" element={<AuditPage />} />
              <Route path="/reports" element={<ReportsPage />} />
              <Route path="/reports/:id" element={<ReportDetailPage />} />
              <Route path="/settings" element={<SettingsPage />} />
            </Route>
          </Route>
          <Route
            path="*"
            element={
              <Navigate
                to={activeProfileId && server ? '/workspace' : '/connect'}
                replace
              />
            }
          />
        </Routes>
      </Suspense>
      <ToastViewport />
    </>
  );
}
