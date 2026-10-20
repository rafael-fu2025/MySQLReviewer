import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowRight,
  Database,
  Edit3,
  KeyRound,
  Laptop,
  Lock,
  PlugZap,
  Plus,
  ShieldCheck,
  Trash2,
  Zap,
} from 'lucide-react';
import type { ConnectionProfile, TestConnectionResult } from '@shared/types';
import { APP_VERSION } from '@shared/types';
import { useAppStore } from '@/store/app-store';
import { api, ApiError } from '@/lib/api';
import { formatRelative } from '@/lib/format';
import { ConnectionForm } from '@/components/ConnectionForm';
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  Field,
  IconButton,
  Input,
  Modal,
  PageHeader,
  Spinner,
  cn,
} from '@/components/ui';

function ProfileCard({
  profile,
  active,
  connecting,
  testing,
  onConnect,
  onEdit,
  onDelete,
  onTest,
}: {
  profile: ConnectionProfile;
  active: boolean;
  connecting: boolean;
  testing: boolean;
  onConnect: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onTest: () => void;
}) {
  return (
    <Card
      className={cn(
        'group relative overflow-hidden p-4 transition hover:border-ember/40',
        active && 'border-ember/40',
      )}
    >
      <div
        className="absolute left-0 top-0 h-full w-[3px]"
        style={{ background: profile.color ?? '#ff8a3d' }}
      />
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-[14px] font-bold tracking-tight">
              {profile.name}
            </span>
            {active ? <Badge tone="mint">active</Badge> : null}
            {profile.host === '127.0.0.1' || profile.host === 'localhost' ? (
              <Badge tone="ember">local</Badge>
            ) : null}
          </div>
          <div className="mt-1 font-mono text-[10.5px] text-muted">
            {profile.user}@{profile.host}:{profile.port}
            {profile.database ? ` / ${profile.database}` : ''}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1 opacity-60 transition group-hover:opacity-100">
          <IconButton label="Edit connection" onClick={onEdit}>
            <Edit3 size={14} />
          </IconButton>
          <IconButton label="Delete connection" onClick={onDelete}>
            <Trash2 size={14} />
          </IconButton>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Badge tone={profile.passwordSource === 'saved' ? 'mint' : profile.passwordSource === 'session' ? 'info' : 'warn'}>
          <KeyRound size={10} />
          {profile.passwordSource === 'saved'
            ? 'encrypted password'
            : profile.passwordSource === 'session'
              ? 'session password'
              : 'no saved password'}
        </Badge>
        <Badge>{profile.lastUsedAt ? `used ${formatRelative(profile.lastUsedAt)}` : 'never used'}</Badge>
        <Badge tone={profile.databaseScope === 'selected' ? 'ember' : 'neutral'}>
          {profile.databaseScope === 'selected'
            ? `${profile.allowedDatabases.length} DB scope`
            : 'all databases'}
        </Badge>
        {profile.ssl?.enabled ? <Badge tone="mint">TLS</Badge> : null}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button
          variant="primary"
          size="sm"
          icon={connecting ? <Spinner size={12} /> : <PlugZap size={13} />}
          onClick={onConnect}
          loading={connecting}
        >
          {active ? 'Reconnect' : 'Connect'}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={onTest}
          loading={testing}
          disabled={connecting}
        >
          Test
        </Button>
        <span className="ml-auto text-[10px] text-muted">
          read-only by default
        </span>
      </div>
    </Card>
  );
}

export function ConnectPage() {
  const navigate = useNavigate();
  const profiles = useAppStore((state) => state.profiles);
  const detectedXampp = useAppStore((state) => state.detectedXampp);
  const activeProfileId = useAppStore((state) => state.activeProfileId);
  const server = useAppStore((state) => state.server);
  const connect = useAppStore((state) => state.connect);
  const disconnect = useAppStore((state) => state.disconnect);
  const refreshProfiles = useAppStore((state) => state.refreshProfiles);
  const toast = useAppStore((state) => state.toast);
  const nodeVersion = useAppStore((state) => state.boot?.nodeVersion ?? '');
  const dataDir = useAppStore((state) => state.boot?.dataDir ?? '');
  const version = useAppStore((state) => state.boot?.version ?? APP_VERSION);

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<ConnectionProfile | null>(null);
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [passwordFor, setPasswordFor] = useState<ConnectionProfile | null>(null);
  const [password, setPassword] = useState('');
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<ConnectionProfile | null>(null);
  const [deletingBusy, setDeletingBusy] = useState(false);

  /**
   * Connect to a profile. Returns the failure message instead of throwing so callers
   * that fire it from a click handler cannot produce an unhandled rejection.
   */
  const attempt = async (
    profile: ConnectionProfile,
    suppliedPassword?: string,
  ): Promise<string | null> => {
    setConnectingId(profile.id);
    setError(null);
    try {
      await connect(profile.id, suppliedPassword);
      toast(`Connected to ${profile.name}.`, 'success');
      navigate('/workspace');
      return null;
    } catch (err) {
      const apiError = err instanceof ApiError ? err : null;
      const message = apiError?.message ?? (err instanceof Error ? err.message : String(err));
      if (apiError?.code === 'ACCESS_DENIED') {
        if (suppliedPassword === undefined) {
          setPasswordFor(profile);
          setPassword('');
        }
        setPasswordError(message);
      } else {
        setError(message);
      }
      return message;
    } finally {
      setConnectingId(null);
    }
  };

  const testProfile = async (profile: ConnectionProfile): Promise<void> => {
    if (testingId) return;
    setTestingId(profile.id);
    try {
      const result = await api.post<TestConnectionResult>('/api/connections/test', {
        name: profile.name,
        host: profile.host,
        port: profile.port,
        user: profile.user,
        database: profile.database ?? undefined,
        socketPath: profile.socketPath ?? undefined,
        ssl: profile.ssl ?? undefined,
        rememberPassword: profile.rememberPassword,
        profileId: profile.id,
      });
      if (result.ok) {
        toast(
          `${result.server?.version ?? 'MySQL'} responded in ${result.latencyMs} ms.`,
          'success',
        );
      } else {
        toast(result.error ?? 'Connection failed.', 'error');
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setTestingId(null);
    }
  };

  const removeProfile = async (): Promise<void> => {
    if (!deleting) return;
    setDeletingBusy(true);
    try {
      await api.del(`/api/connections/${deleting.id}`);
      // Clear the live session first so a failed refresh cannot leave a deleted profile active.
      if (activeProfileId === deleting.id) await disconnect();
      await refreshProfiles();
      toast(`Deleted ${deleting.name}.`, 'success');
      setDeleting(null);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setDeletingBusy(false);
    }
  };

  return (
    <div className="h-screen overflow-auto">
      <div className="mx-auto max-w-[1180px] px-5 py-8 sm:px-8">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="brand-mark" style={{ width: 42, height: 42 }}>
              <Database size={20} />
            </div>
            <div>
              <div className="text-[18px] font-extrabold tracking-tight">MyLens</div>
              <div className="text-[10px] uppercase tracking-[0.16em] text-muted">
                MySQL Review Studio
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Badge tone="mint">
              <ShieldCheck size={11} /> local only
            </Badge>
            <Badge>v{version}</Badge>
          </div>
        </header>

        <div className="hero-grid mt-7">
          <div className="hero-panel">
            <div className="relative z-10">
              <h1 className="text-[23px] font-extrabold tracking-tight">
                Connect to your MySQL server
              </h1>
              <p className="mt-2 max-w-xl text-[12.5px] leading-6 text-muted">
                Choose a profile to explore schemas, run safe queries, review EXPLAIN plans,
                audit access, and practice with SQL Lab.
              </p>
              <div className="mt-6 flex flex-wrap gap-2">
                <Button
                  variant="primary"
                  size="lg"
                  icon={<Plus size={15} />}
                  onClick={() => {
                    setEditing(null);
                    setFormOpen(true);
                  }}
                >
                  Add a connection
                </Button>
                {activeProfileId && server ? (
                  <Button
                    variant="secondary"
                    size="lg"
                    icon={<ArrowRight size={15} />}
                    onClick={() => navigate('/workspace')}
                  >
                    Continue to workspace
                  </Button>
                ) : null}
              </div>
            </div>
          </div>

          <Card className="flex flex-col gap-4 p-5">
            <div className="flex items-center gap-2">
              <Laptop size={16} className="text-ember" />
              <div className="text-[13px] font-bold">This machine</div>
              <Badge tone="mint" className="ml-auto">
                loopback
              </Badge>
            </div>
            <div className="divider" />
            <div className="flex flex-col gap-2.5 text-[11.5px]">
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted">XAMPP detected</span>
                <span className="font-mono text-[10.5px]">
                  {detectedXampp ? detectedXampp.path : 'not detected'}
                </span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted">MySQL port</span>
                <span className="font-mono text-[10.5px]">
                  {detectedXampp?.port ?? 3306}
                </span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted">Node runtime</span>
                <span className="font-mono text-[10.5px]">{nodeVersion}</span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted">Data directory</span>
                <span className="max-w-[190px] truncate font-mono text-[10.5px]" title={dataDir}>
                  {dataDir}
                </span>
              </div>
            </div>
            <div className="divider" />
            <div className="rounded-xl border border-line-soft bg-panel-2/50 p-3 text-[11px] leading-5 text-muted">
              <div className="mb-1 flex items-center gap-1.5 font-semibold text-ink-soft">
                <Lock size={12} className="text-mint" /> Safety model
              </div>
              The API binds to 127.0.0.1, validates the Host/Origin, and requires a per-boot
              token. Saved passwords and AI keys are encrypted with AES-256-GCM. Cloud AI is
              only called when you click a review action.
            </div>
            {activeProfileId && server ? (
              <div className="rounded-xl border border-mint/25 bg-mint/5 p-3">
                <div className="flex items-center gap-2 text-[11.5px] font-semibold text-mint">
                  <Zap size={13} /> Connected
                </div>
                <div className="mt-1 font-mono text-[10px] text-muted">
                  {server.version} · {server.flavor}
                </div>
                <div className="mt-2 flex gap-2">
                  <Button
                    size="sm"
                    variant="primary"
                    onClick={() => navigate('/workspace')}
                  >
                    Open workspace
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void disconnect()}
                  >
                    Disconnect
                  </Button>
                </div>
              </div>
            ) : null}
          </Card>
        </div>

        <section className="mt-8">
          <PageHeader
            title="Connections"
            subtitle="The seeded XAMPP profile is ready. Add a profile for any other MySQL or MariaDB server."
            actions={
              <Button
                variant="secondary"
                size="sm"
                icon={<Plus size={13} />}
                onClick={() => {
                  setEditing(null);
                  setFormOpen(true);
                }}
              >
                New connection
              </Button>
            }
          />

          {error ? (
            <div className="callout danger mt-3 flex items-start gap-2">
              <Lock size={14} className="mt-0.5 shrink-0" />
              <div>
                {error}
                <div className="mt-1 text-[11px] text-muted">
                  Make sure MySQL is running in XAMPP and that the user can connect from this host.
                </div>
              </div>
            </div>
          ) : null}

          <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {profiles.map((profile) => (
              <ProfileCard
                key={profile.id}
                profile={profile}
                active={profile.id === activeProfileId}
                connecting={connectingId === profile.id}
                testing={testingId === profile.id}
                onConnect={() => void attempt(profile)}
                onEdit={() => {
                  setEditing(profile);
                  setFormOpen(true);
                }}
                onDelete={() => setDeleting(profile)}
                onTest={() => void testProfile(profile)}
              />
            ))}
            <button
              type="button"
              className="flex min-h-[170px] flex-col items-center justify-center gap-2 rounded-[14px] border border-dashed border-line text-muted transition hover:border-ember/40 hover:text-ink"
              onClick={() => {
                setEditing(null);
                setFormOpen(true);
              }}
            >
              <Plus size={20} />
              <span className="text-[12px] font-semibold">New connection</span>
              <span className="text-[10.5px]">MySQL 5.7 · 8.x · MariaDB 10.x</span>
            </button>
          </div>
        </section>

        <footer className="mt-10 flex flex-wrap items-center justify-between gap-2 pb-4 text-[10.5px] text-muted">
          <span>MyLens is local-first. Nothing is uploaded unless you trigger a cloud AI review.</span>
          <span className="font-mono">localhost · AES-256-GCM · no telemetry</span>
        </footer>
      </div>

      <Modal
        open={formOpen}
        onClose={() => setFormOpen(false)}
        title={editing ? 'Edit connection' : 'New connection'}
        subtitle={editing ? editing.name : 'Works with XAMPP, MySQL 5.7/8.x, and MariaDB 10.x.'}
        size="wide"
      >
        <ConnectionForm
          profile={editing}
          onCancel={() => setFormOpen(false)}
          onSaved={async (profile) => {
            setFormOpen(false);
            setEditing(null);
            await refreshProfiles();
            toast(`Saved ${profile.name}.`, 'success');
          }}
        />
      </Modal>

      <Modal
        open={Boolean(passwordFor)}
        onClose={() => {
          setPasswordFor(null);
          setPassword('');
          setPasswordError(null);
        }}
        title="Password required"
        subtitle={
          passwordFor
            ? `${passwordFor.user}@${passwordFor.host}:${passwordFor.port}`
            : ''
        }
        size="narrow"
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => {
                setPasswordFor(null);
                setPassword('');
                setPasswordError(null);
              }}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={Boolean(connectingId)}
              onClick={async () => {
                if (!passwordFor) return;
                setPasswordError(null);
                const failure = await attempt(passwordFor, password);
                if (!failure) {
                  setPasswordFor(null);
                  setPassword('');
                }
              }}
            >
              Connect
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <p className="text-[12px] text-muted">
            This profile has no saved password. Enter it for this session, or cancel and
            update the profile to remember it.
          </p>
          <Field label="Password" error={passwordError}>
            <Input
              type="password"
              name="mylens-session-password"
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void (async () => {
                    if (!passwordFor) return;
                    setPasswordError(null);
                    const failure = await attempt(passwordFor, password);
                    if (!failure) {
                      setPasswordFor(null);
                      setPassword('');
                    }
                  })();
                }
              }}
              autoFocus
            />
          </Field>
          {passwordError ? <div className="callout danger">{passwordError}</div> : null}
        </div>
      </Modal>

      <ConfirmDialog
        open={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        onConfirm={() => void removeProfile()}
        title="Delete connection?"
        message={
          deleting
            ? `Remove “${deleting.name}” from MyLens. The MySQL server and its data are not touched.`
            : ''
        }
        confirmLabel="Delete connection"
        danger
        loading={deletingBusy}
      />
    </div>
  );
}
