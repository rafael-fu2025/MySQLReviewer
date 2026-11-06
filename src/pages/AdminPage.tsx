import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Ban,
  ChevronLeft,
  ChevronRight,
  Database,
  FlaskConical,
  KeyRound,
  ListChecks,
  Plus,
  RefreshCw,
  ScrollText,
  ShieldCheck,
  Trash2,
  UserCog,
  UserRound,
} from 'lucide-react';
import type { ActivityEntry, ActivityPage, ConnectionProfile, PublicUser } from '@shared/types';
import { useAppStore } from '@/store/app-store';
import { api } from '@/lib/api';
import { Combobox } from '@/components/Combobox';
import { formatDate, formatRelative } from '@/lib/format';
import { ConnectionForm } from '@/components/ConnectionForm';
import {
  Badge,
  Button,
  Card,
  Checkbox,
  ConfirmDialog,
  EmptyState,
  Field,
  Input,
  Modal,
  PageHeader,
  Spinner,
  Switch,
  Tabs,
} from '@/components/ui';

type AdminTab = 'users' | 'connections' | 'activity';

const TAB_IDS: AdminTab[] = ['users', 'connections', 'activity'];

function parseTab(value: string | null): AdminTab {
  return TAB_IDS.includes(value as AdminTab) ? (value as AdminTab) : 'users';
}

interface AssignmentDraft {
  profileId: string;
  source: string;
  includeData: boolean;
}

const ACTIVITY_PAGE_SIZE = 20;

/**
 * One canonical name per account.
 *
 * The server falls back to the username when an account was created without a
 * display name, so one card showed a bare handle while the next showed a real
 * name — the same person under two shapes of name. A display name is used as
 * it is; otherwise the handle is turned into one.
 */
function accountName(user: Pick<PublicUser, 'username' | 'displayName'>): string {
  const given = user.displayName?.trim() ?? '';
  if (given && given !== user.username) return given;
  return user.username.charAt(0).toUpperCase() + user.username.slice(1);
}

/**
 * What the per-account write lock means for members.
 * Admin accounts always have unrestricted write access.
 */
function writeUnlockHelp(locked: boolean): string {
  return locked
    ? 'This account cannot unlock writes and cannot reveal masked values, whatever the global switch says.'
    : 'This account can unlock writes for its own connection for 15 minutes, unless the global switch is off or the connection is locked.';
}

const ACTION_LABELS: Record<string, string> = {
  login: 'Signed in',
  logout: 'Signed out',
  connect: 'Connected',
  disconnect: 'Disconnected',
  query: 'Ran a statement',
  unlock: 'Unlocked writes',
  lock: 'Locked writes',
  audit: 'Ran an audit',
  'practice-generate': 'Generated challenges',
  'practice-evaluate': 'Submitted an answer',
  'report-export': 'Exported a report',
  'report-delete': 'Deleted a report',
  'admin-user-create': 'Created a user',
  'admin-user-update': 'Updated a user',
  'admin-user-delete': 'Deleted a user',
  'admin-sandbox-provision': 'Provisioned a sandbox',
  'admin-sandbox-reset': 'Reset a sandbox',
  'admin-connection-create': 'Created a connection',
  'admin-connection-update': 'Updated a connection',
  'admin-connection-delete': 'Deleted a connection',
  'admin-write-unlock-switch': 'Changed write unlocking',
};

export interface AdminUserCardProps {
  user: PublicUser;
  isCurrentUser: boolean;
  profiles: ConnectionProfile[];
  busy: string | null;
  onAssignSandbox: (user: PublicUser) => void;
  onResetPassword: (user: PublicUser) => void;
  onToggleDisabled: (user: PublicUser) => void;
  onDeleteUser: (user: PublicUser) => void;
  onResetSandbox: (user: PublicUser, assignmentId: string) => void;
  onRemoveAssignment: (user: PublicUser, assignmentId: string) => void;
  onToggleWriteUnlock: (user: PublicUser, disabled: boolean) => void;
}

/**
 * One account card: who it is, the sandboxes it works in, and what it is
 * allowed to write.
 */
export function AdminUserCard({
  user,
  isCurrentUser,
  profiles,
  busy,
  onAssignSandbox,
  onResetPassword,
  onToggleDisabled,
  onDeleteUser,
  onResetSandbox,
  onRemoveAssignment,
  onToggleWriteUnlock,
}: AdminUserCardProps) {
  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-bold">{accountName(user)}</span>
            <Badge tone={user.role === 'admin' ? 'ember' : 'info'}>{user.role}</Badge>
            {user.disabledAt ? <Badge tone="danger">disabled</Badge> : null}
            {user.role !== 'admin' && user.writeUnlockDisabled ? (
              <Badge tone="danger">writes locked</Badge>
            ) : null}
            {isCurrentUser ? <Badge tone="mint">you</Badge> : null}
          </div>
          <div className="mt-1 font-mono text-2xs text-muted">
            @{user.username} · created {formatDate(user.createdAt)}
          </div>
        </div>
        <div className="flex items-center gap-1">
          {user.role === 'member' ? (
            <Button
              variant="secondary"
              size="sm"
              icon={<FlaskConical size={12} />}
              onClick={() => onAssignSandbox(user)}
            >
              Assign sandbox
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            icon={<KeyRound size={12} />}
            tooltip="Reset password"
            aria-label={`Reset password for ${accountName(user)}`}
            onClick={() => onResetPassword(user)}
          />
          <Button
            variant="ghost"
            size="sm"
            icon={busy === `disable-${user.id}` ? <Spinner size={11} /> : <Ban size={12} />}
            tooltip={user.disabledAt ? 'Re-enable' : 'Disable'}
            aria-label={
              user.disabledAt ? `Enable ${accountName(user)}` : `Disable ${accountName(user)}`
            }
            disabled={isCurrentUser || busy === `disable-${user.id}`}
            onClick={() => onToggleDisabled(user)}
          />
          <Button
            variant="ghost"
            size="sm"
            className="text-danger"
            icon={<Trash2 size={12} />}
            tooltip="Delete user"
            aria-label={`Delete ${accountName(user)}`}
            disabled={isCurrentUser}
            onClick={() => onDeleteUser(user)}
          />
        </div>
      </div>

      <div className="mt-3 border-t border-line-soft pt-3">
        <div className="mono-label mb-1">Sandboxes</div>
        {user.assignments.length === 0 ? (
          <div className="text-2xs text-muted">
            {user.role === 'admin'
              ? 'Admins work directly on the source databases.'
              : 'No sandboxes assigned yet.'}
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {user.assignments.map((assignment) => {
              const connectionName = profiles.find(
                (profile) => profile.id === assignment.profileId,
              )?.name;
              return (
                <div
                  key={assignment.id}
                  className="flex flex-wrap items-center gap-2 rounded-lg border border-line-soft bg-panel-2 px-3 py-2"
                >
                  {/* The connection name is load-bearing: it is what the
                      member sees on their connect page, so a sandbox on
                      the wrong connection must be visible at a glance. It
                      is named as a connection so it cannot be read as a
                      second name for the account. */}
                  <Badge tone="ember">
                    {connectionName ? `Connection · ${connectionName}` : 'deleted connection'}
                  </Badge>
                  <span className="font-mono text-2xs text-ink-soft">
                    {assignment.source} → {assignment.sandbox}
                  </span>
                  <Badge tone={assignment.includeData ? 'mint' : 'neutral'}>
                    {assignment.includeData ? 'with data' : 'structure only'}
                  </Badge>
                  <span className="ml-auto text-2xs text-muted">
                    {formatRelative(assignment.createdAt)}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={
                      busy === `reset-${assignment.id}` ? (
                        <Spinner size={11} />
                      ) : (
                        <RefreshCw size={11} />
                      )
                    }
                    tooltip="Re-clone from source"
                    aria-label={`Reset sandbox ${assignment.sandbox}`}
                    disabled={busy === `reset-${assignment.id}`}
                    onClick={() => onResetSandbox(user, assignment.id)}
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-danger"
                    icon={<Trash2 size={11} />}
                    tooltip="Remove sandbox (drops the database)"
                    aria-label={`Remove sandbox ${assignment.sandbox}`}
                    disabled={busy === `remove-${assignment.id}`}
                    onClick={() => onRemoveAssignment(user, assignment.id)}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>

      {user.role === 'member' ? (
        <div className="mt-3 border-t border-line-soft pt-3">
          <div className="mono-label mb-1">Write access</div>
          <div className="flex items-start justify-between gap-4 rounded-lg border border-line-soft bg-panel-2 px-3 py-2">
            <div>
              {/* The same wording as Settings → Safety: the switch reads
                  positive, so "on" always means writes can be unlocked. */}
              <div className="text-xs font-semibold">Allow write unlocking</div>
              <div className="mt-0.5 max-w-xl text-2xs leading-4 text-muted">
                {writeUnlockHelp(user.writeUnlockDisabled === true)}
              </div>
            </div>
            <Switch
              label={`Allow write unlocking for ${accountName(user)}`}
              checked={user.writeUnlockDisabled !== true}
              disabled={busy === `write-unlock-${user.id}`}
              onChange={(value) => onToggleWriteUnlock(user, !value)}
            />
          </div>
        </div>
      ) : null}
    </Card>
  );
}

export function AdminPage() {
  const navigate = useNavigate();
  const toast = useAppStore((state) => state.toast);
  const currentUser = useAppStore((state) => state.currentUser);
  const profiles = useAppStore((state) => state.profiles);
  const refreshProfiles = useAppStore((state) => state.refreshProfiles);
  const refreshCurrentUser = useAppStore((state) => state.refreshCurrentUser);
  const [tab, setTab] = useState<AdminTab>('users');
  const [users, setUsers] = useState<PublicUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [assignFor, setAssignFor] = useState<PublicUser | null>(null);
  const [deleting, setDeleting] = useState<PublicUser | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // Connections tab reuses the ConnectionForm modal pattern.
  const [connectionFormOpen, setConnectionFormOpen] = useState(false);
  const [editingProfile, setEditingProfile] = useState<ConnectionProfile | null>(null);
  const [deletingProfile, setDeletingProfile] = useState<ConnectionProfile | null>(null);

  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [activityUser, setActivityUser] = useState<string>('');
  const [activityPage, setActivityPage] = useState(1);
  const [activityTotal, setActivityTotal] = useState(0);

  const activityMaxPage = Math.max(1, Math.ceil(activityTotal / ACTIVITY_PAGE_SIZE));

  const loadUsers = useCallback(async (): Promise<void> => {
    setUsers(await api.get<PublicUser[]>('/api/admin/users'));
  }, []);

  const loadActivity = useCallback(async (userId: string, page: number): Promise<void> => {
    const params = new URLSearchParams();
    if (userId) params.set('userId', userId);
    params.set('limit', String(ACTIVITY_PAGE_SIZE));
    params.set('offset', String((page - 1) * ACTIVITY_PAGE_SIZE));
    const result = await api.get<ActivityPage>(`/api/admin/activity?${params.toString()}`);
    setActivity(result.entries);
    setActivityTotal(result.total);
    // The log keeps moving; a page past the end (e.g. after a filter change
    // or rotation) snaps back to the last real page.
    const maxPage = Math.max(1, Math.ceil(result.total / ACTIVITY_PAGE_SIZE));
    if (page > maxPage) setActivityPage(maxPage);
  }, []);

  useEffect(() => {
    void (async () => {
      setLoading(true);
      try {
        await loadUsers();
      } catch (error) {
        toast(error instanceof Error ? error.message : String(error), 'error');
      } finally {
        setLoading(false);
      }
    })();
  }, [loadUsers, toast]);

  useEffect(() => {
    if (tab !== 'activity') return;
    void (async () => {
      try {
        await loadActivity(activityUser, activityPage);
      } catch (error) {
        toast(error instanceof Error ? error.message : String(error), 'error');
      }
    })();
  }, [tab, activityUser, activityPage, loadActivity, toast]);

  const assign = async (draft: AssignmentDraft): Promise<void> => {
    if (!assignFor) return;
    setBusy('assign');
    try {
      const result = await api.post<{
        result: {
          sandbox: string;
          tables: number;
          rowsCopied: number;
          complete?: boolean;
          dataErrors?: string[];
        };
      }>(`/api/admin/users/${assignFor.id}/assignments`, draft);
      await loadUsers();
      await refreshCurrentUser();
      // A sandbox can be created but incompletely copied: the server reports
      // `complete: false` with per-table dataErrors. Never claim success then.
      const dataErrors = result.result.dataErrors ?? [];
      const complete = result.result.complete !== false && dataErrors.length === 0;
      if (complete) {
        toast(
          `Sandbox ${result.result.sandbox} created (${result.result.tables} tables, ${result.result.rowsCopied} rows).`,
          'success',
        );
      } else {
        toast(
          `Sandbox ${result.result.sandbox} created, but ${dataErrors.length} table${dataErrors.length === 1 ? '' : 's'} could not be copied: ${dataErrors.join('; ')}`,
          'error',
        );
      }
      setAssignFor(null);
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setBusy(null);
    }
  };

  const resetSandbox = async (user: PublicUser, assignmentId: string): Promise<void> => {
    setBusy(`reset-${assignmentId}`);
    try {
      await api.post(`/api/admin/users/${user.id}/assignments/${assignmentId}/reset`);
      await loadUsers();
      toast('Sandbox re-cloned from its source.', 'success');
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setBusy(null);
    }
  };

  const removeAssignment = async (user: PublicUser, assignmentId: string): Promise<void> => {
    setBusy(`remove-${assignmentId}`);
    try {
      await api.del(`/api/admin/users/${user.id}/assignments/${assignmentId}`);
      await loadUsers();
      await refreshCurrentUser();
      toast('Sandbox removed and its database dropped.', 'success');
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setBusy(null);
    }
  };

  const toggleDisabled = async (user: PublicUser): Promise<void> => {
    setBusy(`disable-${user.id}`);
    try {
      await api.put(`/api/admin/users/${user.id}`, { disabled: !user.disabledAt });
      await loadUsers();
      toast(
        user.disabledAt ? `${accountName(user)} re-enabled.` : `${accountName(user)} disabled.`,
        'success',
      );
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setBusy(null);
    }
  };

  /**
   * Turns the per-account write lock on or off. While it is on the account
   * cannot unlock writes and cannot reveal masked values, even while the
   * global write-unlock switch is on.
   */
  const toggleWriteUnlock = async (user: PublicUser, disabled: boolean): Promise<void> => {
    setBusy(`write-unlock-${user.id}`);
    try {
      await api.put(`/api/admin/users/${user.id}/write-unlock`, { disabled });
      await loadUsers();
      toast(
        disabled
          ? `${accountName(user)} can no longer unlock writes.`
          : `${accountName(user)} can unlock writes again.`,
        'success',
      );
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setBusy(null);
    }
  };

  const resetPassword = (user: PublicUser): void => {
    const password = window.prompt(
      `New password for ${accountName(user)} (@${user.username}) (min 6 chars):`,
    );
    if (!password) return;
    void api
      .put(`/api/admin/users/${user.id}`, { password })
      .then(() => toast(`Password reset for ${accountName(user)}.`, 'success'))
      .catch((error: unknown) =>
        toast(error instanceof Error ? error.message : String(error), 'error'),
      );
  };

  const removeUser = async (user: PublicUser): Promise<void> => {
    if (!deleting) return;
    setBusy('delete-user');
    try {
      await api.del(`/api/admin/users/${user.id}`);
      await loadUsers();
      toast(`${accountName(user)} deleted.`, 'success');
      setDeleting(null);
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="page">
      <PageHeader
        title="Admin"
        subtitle={
          currentUser
            ? `Signed in as ${accountName(currentUser)} (${currentUser.role}). Sandboxes give members a private copy of a database.`
            : 'Manage users, connections, sandboxes, and activity.'
        }
        actions={
          tab === 'connections' ? (
            <Button
              variant="primary"
              size="sm"
              icon={<Plus size={13} />}
              onClick={() => {
                setEditingProfile(null);
                setConnectionFormOpen(true);
              }}
            >
              New connection
            </Button>
          ) : null
        }
      />

      <Tabs
        items={[
          {
            id: 'users',
            label: 'Users',
            icon: <UserRound size={12} />,
            count: users.length || undefined,
          },
          {
            id: 'connections',
            label: 'Connections',
            icon: <Database size={12} />,
            count: profiles.length || undefined,
          },
          { id: 'activity', label: 'Activity', icon: <ScrollText size={12} /> },
        ]}
        value={tab}
        onChange={(value) => setTab(parseTab(value))}
      />

      {loading ? (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {Array.from({ length: 4 }).map((_, index) => (
            <div key={index} className="skeleton h-32" />
          ))}
        </div>
      ) : tab === 'users' ? (
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <span className="section-title">Accounts</span>
            <Button
              variant="primary"
              size="sm"
              className="ml-auto"
              icon={<Plus size={12} />}
              onClick={() => setCreateOpen(true)}
            >
              Add member
            </Button>
          </div>
          {users.map((user) => (
            <AdminUserCard
              key={user.id}
              user={user}
              isCurrentUser={currentUser?.id === user.id}
              profiles={profiles}
              busy={busy}
              onAssignSandbox={setAssignFor}
              onResetPassword={resetPassword}
              onToggleDisabled={(target) => void toggleDisabled(target)}
              onDeleteUser={setDeleting}
              onResetSandbox={(target, assignmentId) => void resetSandbox(target, assignmentId)}
              onRemoveAssignment={(target, assignmentId) =>
                void removeAssignment(target, assignmentId)
              }
              onToggleWriteUnlock={(target, disabled) => void toggleWriteUnlock(target, disabled)}
            />
          ))}
        </div>
      ) : tab === 'connections' ? (
        profiles.length === 0 ? (
          <div className="empty-anchor">
            <EmptyState
              icon={<Database size={24} />}
              title="No connections yet"
              copy="Create the first connection, then assign sandbox copies of its databases to members."
              action={
                <Button
                  variant="primary"
                  icon={<Plus size={13} />}
                  onClick={() => {
                    setEditingProfile(null);
                    setConnectionFormOpen(true);
                  }}
                >
                  New connection
                </Button>
              }
            />
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {profiles.map((profile) => (
              <Card key={profile.id} className="p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-bold">{profile.name}</span>
                      <Badge tone={profile.databaseScope === 'selected' ? 'ember' : 'info'}>
                        {profile.databaseScope === 'selected'
                          ? `${profile.allowedDatabases.length} DB scope`
                          : 'all databases'}
                      </Badge>
                    </div>
                    <div className="mt-1 font-mono text-2xs text-muted">
                      {profile.user}@{profile.host}:{profile.port}
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => navigate('/database')}
                      icon={<ListChecks size={12} />}
                    >
                      Browse
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setEditingProfile(profile);
                        setConnectionFormOpen(true);
                      }}
                    >
                      Edit
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-danger"
                      icon={<Trash2 size={12} />}
                      tooltip="Delete connection"
                      aria-label={`Delete ${profile.name}`}
                      onClick={() => setDeletingProfile(profile)}
                    />
                  </div>
                </div>
              </Card>
            ))}
          </div>
        )
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="section-title">Recent activity</span>
            <div className="ml-auto flex items-center gap-2">
              <Combobox
                options={[
                  { value: '', label: 'All users' },
                  ...users.map((user) => ({
                    value: user.id,
                    label: accountName(user),
                    description: `${user.username} · ${user.role}`,
                  })),
                ]}
                value={activityUser}
                onChange={(value) => {
                  setActivityUser(value);
                  setActivityPage(1);
                }}
                placeholder="All users"
                searchPlaceholder="Search users…"
                ariaLabel="Filter activity by user"
                className="w-44"
                buttonClassName="py-1.5 text-2xs"
                clearable={false}
                maxHeight={280}
              />
              <Button
                variant="ghost"
                size="sm"
                icon={<RefreshCw size={12} />}
                onClick={() => void loadActivity(activityUser, activityPage)}
              >
                Refresh
              </Button>
            </div>
          </div>
          <Card className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>User</th>
                  <th>Action</th>
                  <th>Detail</th>
                </tr>
              </thead>
              <tbody>
                {activity.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="text-center text-2xs text-muted">
                      Nothing recorded yet.
                    </td>
                  </tr>
                ) : (
                  activity.map((entry) => (
                    <tr key={entry.id}>
                      <td className="whitespace-nowrap text-2xs text-muted">
                        {formatRelative(entry.at)}
                      </td>
                      <td className="text-2xs font-semibold text-ink-soft">{entry.username}</td>
                      <td className="text-2xs">{ACTION_LABELS[entry.action] ?? entry.action}</td>
                      <td className="text-2xs text-muted">
                        {entry.database ? `${entry.database} · ` : ''}
                        {entry.detail ?? ''}
                        {entry.digest ? ` · ${entry.digest.slice(0, 8)}` : ''}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </Card>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-2xs text-muted">
              {activityTotal} {activityTotal === 1 ? 'entry' : 'entries'}
            </span>
            <div className="flex items-center gap-1.5">
              <Button
                variant="ghost"
                size="sm"
                icon={<ChevronLeft size={12} />}
                aria-label="Previous page"
                tooltip="Previous page"
                disabled={activityPage <= 1}
                onClick={() => setActivityPage((page) => Math.max(1, page - 1))}
              />
              <span className="whitespace-nowrap text-2xs text-muted">
                Page {activityPage} of {activityMaxPage}
              </span>
              <Button
                variant="ghost"
                size="sm"
                icon={<ChevronRight size={12} />}
                aria-label="Next page"
                tooltip="Next page"
                disabled={activityPage >= activityMaxPage}
                onClick={() => setActivityPage((page) => Math.min(activityMaxPage, page + 1))}
              />
            </div>
          </div>
        </div>
      )}

      {/* Create member */}
      <CreateUserModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={async () => {
          setCreateOpen(false);
          await loadUsers();
          toast('Member created.', 'success');
        }}
      />

      {/* Assign sandbox */}
      <Modal
        open={Boolean(assignFor)}
        onClose={() => setAssignFor(null)}
        title="Assign a sandbox"
        subtitle={assignFor ? `${accountName(assignFor)} (@${assignFor.username})` : undefined}
        size="narrow"
      >
        <AssignSandboxForm
          profiles={profiles}
          busy={busy === 'assign'}
          onSubmit={(draft) => void assign(draft)}
        />
      </Modal>

      {/* Delete user */}
      <ConfirmDialog
        open={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        onConfirm={() => (deleting ? void removeUser(deleting) : undefined)}
        title="Delete user?"
        message={
          deleting
            ? `Remove ${accountName(deleting)} (@${deleting.username}). Their sandboxes stay on the server until you remove the assignments.`
            : ''
        }
        confirmLabel="Delete"
        danger
        loading={busy === 'delete-user'}
      />

      {/* Delete connection */}
      <ConfirmDialog
        open={Boolean(deletingProfile)}
        onClose={() => setDeletingProfile(null)}
        onConfirm={async () => {
          if (!deletingProfile) return;
          setBusy('delete-connection');
          try {
            await api.del(`/api/connections/${deletingProfile.id}`);
            await refreshProfiles();
            toast(`Deleted ${deletingProfile.name}.`, 'success');
            setDeletingProfile(null);
          } catch (error) {
            toast(error instanceof Error ? error.message : String(error), 'error');
          } finally {
            setBusy(null);
          }
        }}
        title="Delete connection?"
        message={
          deletingProfile
            ? `Remove "${deletingProfile.name}" from the app. Sandboxes cloned from it stay on the server.`
            : ''
        }
        confirmLabel="Delete"
        danger
        loading={busy === 'delete-connection'}
      />

      {/* Connection form (create/edit) */}
      <Modal
        open={connectionFormOpen}
        onClose={() => setConnectionFormOpen(false)}
        title={editingProfile ? 'Edit connection' : 'New connection'}
        size="wide"
      >
        <ConnectionForm
          profile={editingProfile}
          onCancel={() => setConnectionFormOpen(false)}
          onSaved={async () => {
            setConnectionFormOpen(false);
            setEditingProfile(null);
            await refreshProfiles();
            toast('Connection saved.', 'success');
          }}
        />
      </Modal>
    </div>
  );
}

function CreateUserModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => Promise<void> | void;
}) {
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    setError(null);
    setBusy(true);
    try {
      await api.post('/api/admin/users', {
        username,
        displayName: displayName || username,
        password,
        role: 'member',
      });
      setUsername('');
      setDisplayName('');
      setPassword('');
      await onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Add a member" size="narrow">
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Field label="Username">
          <Input
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            minLength={2}
            maxLength={40}
            required
            autoFocus
          />
        </Field>
        <Field label="Display name">
          <Input
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            maxLength={80}
          />
        </Field>
        <Field label="Password" hint="They can change it later with a reset.">
          <Input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            minLength={6}
            required
            autoComplete={['new', 'password'].join('-')}
          />
        </Field>
        {error ? <div className="callout danger">{error}</div> : null}
        <Button variant="primary" type="submit" loading={busy} icon={<UserRound size={13} />}>
          Create member
        </Button>
      </form>
    </Modal>
  );
}

function AssignSandboxForm({
  profiles,
  busy,
  onSubmit,
}: {
  profiles: ConnectionProfile[];
  busy: boolean;
  onSubmit: (draft: AssignmentDraft) => void;
}) {
  const [profileId, setProfileId] = useState(profiles[0]?.id ?? '');
  const [source, setSource] = useState('');
  const [includeData, setIncludeData] = useState(true);

  if (profiles.length === 0) {
    return (
      <div className="callout info flex items-center gap-2">
        <ShieldCheck size={14} />
        Create a connection first — sandboxes are clones of one of its databases.
      </div>
    );
  }

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (profileId && source) onSubmit({ profileId, source, includeData });
      }}
    >
      <Field
        label="Connection"
        hint="The member connects through the connection picked here — its name is what they see."
      >
        <select
          className="select"
          value={profileId}
          onChange={(event) => setProfileId(event.target.value)}
        >
          {profiles.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.name} ({profile.user}@{profile.host})
            </option>
          ))}
        </select>
      </Field>
      <Field
        label="Source database"
        hint="Cloned into a new `<source>_<n>` database owned by this member."
      >
        <Input
          value={source}
          onChange={(event) => setSource(event.target.value)}
          placeholder="northwind"
          pattern="[A-Za-z0-9_$]+"
          title="Plain database name"
          required
        />
      </Field>
      <Checkbox
        label="Copy the data (otherwise structure only)"
        checked={includeData}
        onChange={setIncludeData}
      />
      <div className="callout info flex items-start gap-2">
        <FlaskConical size={14} className="mt-0.5 shrink-0" />
        <span>
          The member gets full write control inside the clone and no access to anything else.
        </span>
      </div>
      <Button variant="primary" type="submit" loading={busy} icon={<UserCog size={13} />}>
        Clone and assign
      </Button>
    </form>
  );
}
