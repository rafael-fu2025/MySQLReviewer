import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowRight,
  CheckCircle2,
  Database,
  Edit3,
  Laptop,
  Lock,
  LogOut,
  PlugZap,
  Plus,
  ShieldCheck,
  Trash2,
  UserRound,
  Zap,
} from 'lucide-react';
import type { ConnectionProfile, TestConnectionResult } from '@shared/types';
import { useAppStore } from '@/store/app-store';
import { api, ApiError } from '@/lib/api';
import {
  compatLine,
  connectionAccessDeniedMessage,
  deleteConnectionConfirmLabel,
  deleteConnectionMessage,
  deleteConnectionTitle,
} from '@/lib/copy';
import { formatRelative } from '@/lib/format';
import { ConnectionForm } from '@/components/ConnectionForm';
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  IconButton,
  Modal,
  PageHeader,
  Spinner,
} from '@/components/ui';
import { cn } from '@/lib/utils';

/**
 * The security model, one fact per line. The safety card used to be a
 * five-line paragraph nobody scans.
 */
const SAFETY_MODEL_FACTS = [
  'The API binds to 127.0.0.1 and validates the Host/Origin header.',
  'Every request needs the per-boot token.',
  'Saved passwords and AI keys are encrypted with AES-256-GCM.',
  'Cloud AI is called only when you click a review action.',
];

export interface ConnectionCardProps {
  profile: ConnectionProfile;
  active: boolean;
  /**
   * Whether this card's connect action carries the page's primary emphasis.
   * Only one action on the page may hold it.
   */
  primary?: boolean;
  connecting: boolean;
  testing: boolean;
  canManage: boolean;
  /** The member's sandbox databases on this connection (empty for admins). */
  sandboxes: string[];
  onConnect: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onTest: () => void;
}

export function ConnectionCard({
  profile,
  active,
  primary = true,
  connecting,
  testing,
  canManage,
  sandboxes,
  onConnect,
  onEdit,
  onDelete,
  onTest,
}: ConnectionCardProps) {
  const memberView = !canManage;
  return (
    <Card
      className={cn(
        'group relative p-4 transition hover:border-ember/40',
        active && 'border-ember/40',
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-base font-bold tracking-tight">{profile.name}</span>
            {active ? <Badge tone="mint">active</Badge> : null}
            {profile.writeAccess === 'locked' ? (
              <Badge tone="warn">read-only for members</Badge>
            ) : null}
          </div>
          {memberView ? (
            // Members connect through the shared profile but live inside
            // their sandboxes — the server hides everything else, so the
            // card should describe that reality, not the admin's view.
            <div className="mt-1 font-mono text-2xs text-muted">
              {profile.host}:{profile.port}
            </div>
          ) : (
            <div className="mt-1 font-mono text-2xs text-muted">
              {profile.user}@{profile.host}:{profile.port}
              {profile.database ? ` / ${profile.database}` : ''}
            </div>
          )}
        </div>
        {canManage ? (
          <div className="flex shrink-0 items-center gap-1 opacity-80 transition group-hover:opacity-100">
            <IconButton label="Edit connection" onClick={onEdit}>
              <Edit3 size={14} />
            </IconButton>
            <IconButton label="Delete connection" onClick={onDelete}>
              <Trash2 size={14} />
            </IconButton>
          </div>
        ) : null}
      </div>

      {memberView ? (
        <div className="mt-2 font-mono text-2xs text-muted">
          {sandboxes.length > 0
            ? `your databases: ${sandboxes.join(', ')}`
            : 'no sandbox databases assigned yet'}
        </div>
      ) : (
        <div className="mt-2 font-mono text-2xs text-muted">
          {profile.hasPassword ? 'encrypted saved password' : 'passwordless connection'}
          {' · '}
          {profile.lastUsedAt ? `used ${formatRelative(profile.lastUsedAt)}` : 'never used'}
          {' · '}
          {profile.databaseScope === 'selected'
            ? `${profile.allowedDatabases.length} DB scope`
            : 'all databases'}
          {profile.ssl?.enabled ? ' · TLS' : ''}
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button
          variant={primary ? 'primary' : 'secondary'}
          size="sm"
          icon={connecting ? <Spinner size={12} /> : <PlugZap size={13} />}
          onClick={onConnect}
          loading={connecting}
        >
          {active ? 'Reconnect' : 'Connect'}
        </Button>
        {canManage ? (
          <Button
            variant="tertiary"
            size="sm"
            onClick={onTest}
            loading={testing}
            disabled={connecting}
          >
            Test
          </Button>
        ) : null}
      </div>
    </Card>
  );
}

export function HeroPanel({
  canManage,
  connected,
  onNewConnection,
  onOpenWorkspace,
}: {
  canManage: boolean;
  connected: boolean;
  onNewConnection: () => void;
  onOpenWorkspace: () => void;
}) {
  return (
    // `self-start` keeps the card at its content height. The grid row is as
    // tall as the panel next to it, and a stretched hero left ~295px of
    // empty card below the buttons.
    <div className="hero-panel self-start">
      <div className="relative z-10">
        <h1 className="text-2xl font-extrabold tracking-tight">Connect to your MySQL server</h1>
        <p className="mt-2 max-w-xl text-sm leading-relaxed text-muted">
          Pick a connection to browse schemas, run statements, and review plans.
        </p>
        <div className="mt-6 flex flex-wrap gap-2">
          {canManage ? (
            <Button
              variant="secondary"
              size="lg"
              icon={<Plus size={15} />}
              onClick={onNewConnection}
            >
              New connection
            </Button>
          ) : null}
          {connected ? (
            <Button
              variant="secondary"
              size="lg"
              icon={<ArrowRight size={15} />}
              onClick={onOpenWorkspace}
            >
              Continue to workspace
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function MachinePanel({
  xamppPath,
  xamppPort,
  nodeVersion,
  dataDir,
}: {
  xamppPath: string | null;
  xamppPort: number | null;
  nodeVersion: string;
  dataDir: string;
}) {
  return (
    <Card className="flex flex-col gap-4 self-start p-5">
      <div className="flex items-center gap-2">
        <Laptop size={16} className="text-ember" />
        <div className="text-sm font-bold">This machine</div>
      </div>
      <div className="divider" />
      <div className="flex flex-col gap-3 text-xs">
        <div className="flex items-center justify-between gap-3">
          <span className="text-muted">XAMPP detected</span>
          {/* Long paths are cut with an ellipsis, never silently: the full
              value stays in the title so it can still be read. */}
          <span
            className="min-w-0 max-w-[190px] truncate font-mono text-2xs"
            title={xamppPath ?? 'not detected'}
          >
            {xamppPath ?? 'not detected'}
          </span>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="text-muted">MySQL port</span>
          <span className="font-mono text-2xs">{xamppPort ?? 3306}</span>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="text-muted">Node runtime</span>
          <span className="font-mono text-2xs">{nodeVersion}</span>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="text-muted">Data directory</span>
          <span className="min-w-0 max-w-[190px] truncate font-mono text-2xs" title={dataDir}>
            {dataDir}
          </span>
        </div>
      </div>
    </Card>
  );
}

export function SafetyModelPanel() {
  return (
    <Card className="flex flex-col gap-3 p-5">
      <div className="flex items-center gap-2">
        <Lock size={16} className="text-ember" />
        <div className="text-sm font-bold">Safety model</div>
      </div>
      <div className="divider" />
      <ul className="flex flex-col gap-2 text-xs leading-relaxed text-muted">
        {SAFETY_MODEL_FACTS.map((fact) => (
          <li key={fact} className="flex gap-2">
            <CheckCircle2 size={13} className="mt-0.5 shrink-0 text-mint" />
            <span>{fact}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

export function ConnectionStatusPanel({
  version,
  flavor,
  onOpenWorkspace,
  onDisconnect,
}: {
  version: string;
  flavor: string;
  onOpenWorkspace: () => void;
  onDisconnect: () => void;
}) {
  return (
    <Card className="flex flex-col gap-3 p-5">
      <div className="flex items-center gap-2">
        <Zap size={16} className="text-ember" />
        <div className="text-sm font-bold">Connection status</div>
      </div>
      <div className="divider" />
      <div className="rounded-xl border border-mint/25 bg-mint/5 p-3">
        <div className="flex items-center gap-2 text-xs font-semibold text-mint">
          <Zap size={13} /> Connected
        </div>
        <div className="mt-1 font-mono text-2xs text-muted">
          {version} · {flavor}
        </div>
        <div className="mt-2 flex gap-2">
          <Button size="sm" variant="primary" onClick={onOpenWorkspace}>
            Open workspace
          </Button>
          <Button size="sm" variant="tertiary" onClick={onDisconnect}>
            Disconnect
          </Button>
        </div>
      </div>
    </Card>
  );
}

export function MemberAccessPanel() {
  return (
    <Card className="flex flex-col gap-4 self-start p-5">
      <div className="flex items-center gap-2">
        <ShieldCheck size={16} className="text-ember" />
        <div className="text-sm font-bold">How your access works</div>
      </div>
      <div className="divider" />
      <div className="flex flex-col gap-2 text-xs leading-relaxed text-muted">
        <span>
          You connect through the connection your admin assigned. Your work happens inside{' '}
          <span className="font-mono text-ink-soft">sandbox copies</span> of its databases — full
          write control there, and nothing you do touches the originals.
        </span>
        <span>Every statement is recorded in the activity log.</span>
      </div>
    </Card>
  );
}

/**
 * The page's single primary action. While a connection is live it is
 * "Open workspace"; before that it is the connect action on the default
 * connection. Every other action stays secondary, so the page never shows
 * competing orange buttons.
 */
function resolvePrimaryProfileId(profiles: ConnectionProfile[], connected: boolean): string | null {
  if (connected) return null;
  return profiles[0]?.id ?? null;
}

export interface ConnectionsSectionProps {
  canManage: boolean;
  subtitle: string;
  profiles: ConnectionProfile[];
  activeProfileId: string | null;
  /** True while a connection is live; the primary slot then belongs to "Open workspace". */
  connected: boolean;
  connectingId: string | null;
  testingId: string | null;
  /** Sandbox databases per profile id (members only). */
  sandboxesByProfileId: Record<string, string[]>;
  error: string | null;
  onNewConnection: () => void;
  onConnect: (profile: ConnectionProfile) => void;
  onEdit: (profile: ConnectionProfile) => void;
  onDelete: (profile: ConnectionProfile) => void;
  onTest: (profile: ConnectionProfile) => void;
}

export function ConnectionsSection({
  canManage,
  subtitle,
  profiles,
  activeProfileId,
  connected,
  connectingId,
  testingId,
  sandboxesByProfileId,
  error,
  onNewConnection,
  onConnect,
  onEdit,
  onDelete,
  onTest,
}: ConnectionsSectionProps) {
  const primaryProfileId = resolvePrimaryProfileId(profiles, connected);
  return (
    <section className="mt-8">
      <PageHeader
        title="Connections"
        subtitle={subtitle}
        actions={
          canManage ? (
            <Button
              variant="secondary"
              size="sm"
              icon={<Plus size={13} />}
              onClick={onNewConnection}
            >
              New connection
            </Button>
          ) : null
        }
      />

      {error ? (
        <div className="callout danger mt-3 flex items-start gap-2">
          <Lock size={14} className="mt-0.5 shrink-0" />
          <div>{error}</div>
        </div>
      ) : null}

      <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {profiles.map((profile) => (
          <ConnectionCard
            key={profile.id}
            profile={profile}
            active={profile.id === activeProfileId}
            primary={profile.id === primaryProfileId}
            connecting={connectingId === profile.id}
            testing={testingId === profile.id}
            canManage={canManage}
            sandboxes={sandboxesByProfileId[profile.id] ?? []}
            onConnect={() => onConnect(profile)}
            onEdit={() => onEdit(profile)}
            onDelete={() => onDelete(profile)}
            onTest={() => onTest(profile)}
          />
        ))}
      </div>
    </section>
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
  const currentUser = useAppStore((state) => state.currentUser);
  const logout = useAppStore((state) => state.logout);
  const nodeVersion = useAppStore((state) => state.boot?.nodeVersion ?? '');
  const dataDir = useAppStore((state) => state.boot?.dataDir ?? '');
  const canManage = currentUser?.role === 'admin';

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<ConnectionProfile | null>(null);
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<ConnectionProfile | null>(null);
  const [deletingBusy, setDeletingBusy] = useState(false);
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  /**
   * Connect to a profile. Returns the failure message instead of throwing so callers
   * that fire it from a click handler cannot produce an unhandled rejection.
   */
  const attempt = async (profile: ConnectionProfile): Promise<string | null> => {
    setConnectingId(profile.id);
    setError(null);
    try {
      await connect(profile.id);
      toast(`Connected to ${profile.name}.`, 'success');
      navigate('/workspace');
      return null;
    } catch (err) {
      const apiError = err instanceof ApiError ? err : null;
      const message = apiError?.message ?? (err instanceof Error ? err.message : String(err));
      setError(
        apiError?.code === 'ACCESS_DENIED'
          ? connectionAccessDeniedMessage(currentUser?.role)
          : message,
      );
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

  const openNewConnection = (): void => {
    setEditing(null);
    setFormOpen(true);
  };

  const connected = Boolean(activeProfileId && server);
  const sandboxesByProfileId: Record<string, string[]> = {};
  if (currentUser?.role === 'member') {
    for (const assignment of currentUser.assignments) {
      const list = sandboxesByProfileId[assignment.profileId] ?? [];
      list.push(assignment.sandbox);
      sandboxesByProfileId[assignment.profileId] = list;
    }
  }

  return (
    <div className="h-screen overflow-auto">
      <header className="connect-header">
        <div className="connect-header-inner">
          <div className="connect-brand">
            <div className="brand-mark connect-brand-mark">
              <Database size={16} />
            </div>
            <span className="connect-brand-name">MyLens</span>
            <span className="connect-brand-divider" aria-hidden="true" />
            <span className="connect-brand-sub">MySQL Review Studio</span>
          </div>

          <div className="connect-session">
            <div className="connect-account">
              <span className="connect-account-icon">
                <UserRound size={13} />
              </span>
              <span className="connect-account-name">{currentUser?.displayName}</span>
              <span className="connect-account-role">{currentUser?.role}</span>
            </div>
            <Button
              variant="secondary"
              size="sm"
              className="connect-signout"
              icon={<LogOut size={13} />}
              onClick={() => setConfirmSignOut(true)}
            >
              Sign out
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1180px] px-5 pb-10 pt-8 sm:px-8">
        <div className="hero-grid">
          <HeroPanel
            canManage={canManage}
            connected={connected}
            onNewConnection={openNewConnection}
            onOpenWorkspace={() => navigate('/workspace')}
          />

          {canManage ? (
            <MachinePanel
              xamppPath={detectedXampp?.path ?? null}
              xamppPort={detectedXampp?.port ?? null}
              nodeVersion={nodeVersion}
              dataDir={dataDir}
            />
          ) : (
            <MemberAccessPanel />
          )}
        </div>

        {/* The security model and the live connection state are their own
            panels: the machine card used to carry all three at once. */}
        <div className="mt-4 grid grid-cols-1 items-start gap-4 md:grid-cols-2">
          {canManage ? <SafetyModelPanel /> : null}
          {connected && server ? (
            <ConnectionStatusPanel
              version={server.version}
              flavor={server.flavor}
              onOpenWorkspace={() => navigate('/workspace')}
              onDisconnect={() => void disconnect()}
            />
          ) : null}
        </div>

        <ConnectionsSection
          canManage={canManage}
          subtitle={
            canManage
              ? `A seeded XAMPP connection is ready; add one for any other server (${compatLine}).`
              : 'Connections your admin assigned to you.'
          }
          profiles={profiles}
          activeProfileId={activeProfileId}
          connected={connected}
          connectingId={connectingId}
          testingId={testingId}
          sandboxesByProfileId={sandboxesByProfileId}
          error={error}
          onNewConnection={openNewConnection}
          onConnect={(profile) => void attempt(profile)}
          onEdit={(profile) => {
            setEditing(profile);
            setFormOpen(true);
          }}
          onDelete={(profile) => setDeleting(profile)}
          onTest={(profile) => void testProfile(profile)}
        />
      </main>

      <Modal
        open={formOpen}
        onClose={() => setFormOpen(false)}
        title={editing ? 'Edit connection' : 'New connection'}
        subtitle={editing ? editing.name : `Works with XAMPP (${compatLine}).`}
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

      <ConfirmDialog
        open={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        onConfirm={() => void removeProfile()}
        title={deleteConnectionTitle}
        message={deleting ? deleteConnectionMessage(deleting.name) : ''}
        confirmLabel={deleteConnectionConfirmLabel}
        danger
        loading={deletingBusy}
      />

      <ConfirmDialog
        open={confirmSignOut}
        onClose={() => {
          if (!signingOut) setConfirmSignOut(false);
        }}
        onConfirm={() => {
          setSigningOut(true);
          void logout()
            .then(() => {
              setConfirmSignOut(false);
              navigate('/login');
            })
            .catch((err: unknown) => {
              const message = err instanceof Error ? err.message : String(err);
              setError(message);
              toast(message, 'error');
            })
            .finally(() => {
              setSigningOut(false);
            });
        }}
        title="Sign out?"
        message={
          currentUser
            ? `Sign out of MyLens as ${currentUser.displayName}? You'll need your password to get back in.`
            : 'Sign out of MyLens?'
        }
        confirmLabel="Sign out"
        loading={signingOut}
      />
    </div>
  );
}
