import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertTriangle,
  Database,
  KeyRound,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Users,
  XCircle,
} from 'lucide-react';
import type { DbUser, GrantInfo, SecurityAuditResult } from '@shared/types';
import { useAppStore } from '@/store/app-store';
import { api } from '@/lib/api';
import { FindingsList } from '@/components/Findings';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Modal,
  PageHeader,
  Spinner,
  StatCard,
} from '@/components/ui';
import { cn } from '@/lib/utils';

function userLabel(user: DbUser): string {
  return `'${user.user}'@'${user.host}'`;
}

export function SecurityPage() {
  const navigate = useNavigate();
  const activeProfileId = useAppStore((state) => state.activeProfileId);
  const toast = useAppStore((state) => state.toast);
  const [data, setData] = useState<SecurityAuditResult | null>(null);
  // Bumping the request counter reloads the audit; the loading flag and the
  // error are derived from the request the state belongs to.
  const [loadRequest, setLoadRequest] = useState(0);
  const [loadState, setLoadState] = useState<{
    profileId: string;
    request: number;
    error: string | null;
  } | null>(null);
  const [grantsFor, setGrantsFor] = useState<DbUser | null>(null);
  const [grants, setGrants] = useState<GrantInfo | null>(null);
  const [grantsLoading, setGrantsLoading] = useState(false);

  const loading = activeProfileId
    ? loadState === null ||
      loadState.profileId !== activeProfileId ||
      loadState.request !== loadRequest
    : false;
  const error =
    activeProfileId &&
    loadState &&
    loadState.profileId === activeProfileId &&
    loadState.request === loadRequest
      ? loadState.error
      : null;

  // Without a connection there is nothing to show: drop the previous audit.
  if (!activeProfileId && data) {
    setData(null);
  }

  const refresh = (): void => {
    setLoadRequest((value) => value + 1);
  };

  useEffect(() => {
    if (!activeProfileId) return;
    let cancelled = false;
    api
      .get<SecurityAuditResult>(`/api/db/${encodeURIComponent(activeProfileId)}/security`)
      .then((result) => {
        if (cancelled) return;
        setData(result);
        setLoadState({ profileId: activeProfileId, request: loadRequest, error: null });
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadState({
          profileId: activeProfileId,
          request: loadRequest,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [activeProfileId, loadRequest]);

  const openGrants = async (user: DbUser): Promise<void> => {
    if (!activeProfileId) return;
    setGrantsFor(user);
    setGrants(null);
    setGrantsLoading(true);
    try {
      const result = await api.get<GrantInfo>(
        `/api/db/${encodeURIComponent(activeProfileId)}/users/${encodeURIComponent(user.user)}/${encodeURIComponent(user.host)}/grants`,
      );
      setGrants(result);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setGrantsLoading(false);
    }
  };

  if (!activeProfileId) {
    return (
      <div className="page">
        <PageHeader
          title="Security"
          subtitle="Accounts, grants, authentication, and configuration risk."
        />
        <EmptyState
          icon={<Database size={24} />}
          title="Connect to a database"
          copy="The security audit reads accounts, grants, and server settings from the active connection. Choose a profile to run it."
          action={
            <Button variant="primary" onClick={() => navigate('/connect')}>
              Connect to a database
            </Button>
          }
        />
      </div>
    );
  }

  if (loading && !data) {
    return (
      <div className="page">
        <PageHeader
          title="Security"
          subtitle="Accounts, grants, authentication, and configuration risk."
        />
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          {Array.from({ length: 6 }).map((_, index) => (
            <div key={index} className="skeleton h-24" />
          ))}
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="page">
        <PageHeader
          title="Security"
          subtitle="Accounts, grants, authentication, and configuration risk."
        />
        <EmptyState
          icon={<ShieldAlert size={24} />}
          title="Security audit unavailable"
          copy={error ?? 'The server did not return security data.'}
          action={<Button onClick={refresh}>Try again</Button>}
        />
      </div>
    );
  }

  const critical = data.findings.filter(
    (finding) => finding.severity === 'critical' || finding.severity === 'high',
  ).length;
  const passwordless = data.users.filter((user) => !user.passwordSet).length;
  const wildcard = data.users.filter((user) => user.host.includes('%') || user.host === '*').length;
  const grantOption = data.users.filter((user) => user.grantPriv).length;

  return (
    <div className="page">
      <PageHeader
        title="Security"
        subtitle="Account inventory, authentication posture, privilege flags, and server-side security settings."
        actions={
          <>
            <Badge tone={critical > 0 ? 'danger' : 'mint'}>
              {critical} high-impact finding{critical === 1 ? '' : 's'}
            </Badge>
            <Button
              variant="secondary"
              size="sm"
              icon={loading ? <Spinner size={12} /> : <RefreshCw size={12} />}
              onClick={refresh}
              loading={loading}
            >
              Refresh
            </Button>
          </>
        }
      />

      {error ? (
        <div className="callout danger flex items-start gap-2">
          <XCircle size={15} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Accounts"
          value={data.users.length}
          icon={<Users size={14} />}
          tone="info"
        />
        <StatCard
          label="Passwordless"
          value={passwordless}
          icon={<KeyRound size={14} />}
          tone={passwordless > 0 ? 'danger' : 'mint'}
          sub="excluding socket accounts"
        />
        <StatCard
          label="Wildcard hosts"
          value={wildcard}
          icon={<ShieldAlert size={14} />}
          tone={wildcard > 0 ? 'warn' : 'mint'}
        />
        <StatCard
          label="Grant option"
          value={grantOption}
          icon={<ShieldCheck size={14} />}
          tone={grantOption > 0 ? 'warn' : 'mint'}
        />
      </div>

      <div className="callout info flex items-start gap-2">
        <AlertTriangle size={15} className="mt-0.5 shrink-0" />
        <div>
          <div className="font-semibold text-ink">This is a local XAMPP server.</div>
          <div className="mt-0.5 text-[11.5px] text-muted">
            Passwordless root accounts and wildcard binding are convenient on a laptop but unsafe on
            a network. Set passwords, restrict accounts to localhost, and keep MySQL bound to
            127.0.0.1 when you are not intentionally sharing it.
          </div>
        </div>
      </div>

      <Card className="overflow-hidden">
        <div className="flex items-center gap-2 border-b border-line-soft p-3">
          <div className="section-title">Accounts</div>
        </div>
        {data.users.length === 0 ? (
          <EmptyState
            icon={<Users size={22} />}
            title="No accounts visible"
            copy="The current user may lack SELECT on mysql.user or information_schema.USER_PRIVILEGES."
          />
        ) : (
          <div className="overflow-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Account</th>
                  <th>Plugin</th>
                  <th>Password</th>
                  <th>Host pattern</th>
                  <th>Privilege flags</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.users.map((user) => {
                  const label = userLabel(user);
                  const isWildcard = user.host.includes('%') || user.host === '*';
                  return (
                    <tr key={label}>
                      <td className="font-semibold text-ink">{label}</td>
                      <td className="font-mono">{user.plugin || '—'}</td>
                      <td>
                        <Badge tone={user.passwordSet ? 'mint' : 'danger'}>
                          {user.passwordSet ? 'set' : 'empty'}
                        </Badge>
                      </td>
                      <td>
                        <Badge tone={isWildcard ? 'warn' : 'neutral'}>
                          {isWildcard ? 'wildcard' : 'scoped'}
                        </Badge>
                      </td>
                      <td>
                        <div className="flex flex-wrap gap-1">
                          {user.superPriv ? <Badge tone="warn">SUPER</Badge> : null}
                          {user.filePriv ? <Badge tone="warn">FILE</Badge> : null}
                          {user.grantPriv ? <Badge tone="danger">GRANT</Badge> : null}
                          {user.processPriv ? <Badge tone="warn">PROCESS</Badge> : null}
                          {user.createUserPriv ? <Badge tone="warn">CREATE USER</Badge> : null}
                          {user.shutdownPriv ? <Badge tone="warn">SHUTDOWN</Badge> : null}
                          {!user.superPriv &&
                          !user.filePriv &&
                          !user.grantPriv &&
                          !user.processPriv &&
                          !user.createUserPriv &&
                          !user.shutdownPriv ? (
                            <span className="text-muted">—</span>
                          ) : null}
                        </div>
                      </td>
                      <td>
                        <Button variant="ghost" size="sm" onClick={() => void openGrants(user)}>
                          View grants
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card className="p-4">
        <div className="mb-3 flex items-center gap-2">
          <div className="section-title">Server security settings</div>
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {[
            ['local_infile', data.config.localInfile],
            ['secure_file_priv', data.config.secureFilePriv],
            ['bind_address', data.config.bindAddress],
            ['sql_mode', data.config.sqlMode],
            ['skip_name_resolve', data.config.skipNameResolve],
          ].map(([label, value]) => (
            <div key={label} className="rounded-lg border border-line-soft bg-panel-2/40 p-2.5">
              <div className="mono-label">{label}</div>
              <div
                className={cn(
                  'mt-1 break-words font-mono text-[10.5px]',
                  value == null || value === 'NULL' || value === '' ? 'text-warn' : 'text-ink-soft',
                )}
              >
                {value == null || value === '' ? '(empty)' : value}
              </div>
            </div>
          ))}
        </div>
      </Card>

      <Card className="p-4">
        <div className="mb-3 flex items-center gap-2">
          <div className="section-title">Security findings</div>
          <Badge className="ml-auto">{data.findings.length}</Badge>
        </div>
        <FindingsList
          findings={data.findings}
          emptyTitle="No security findings"
          emptyCopy="The visible accounts and configuration did not trigger any security rules."
        />
      </Card>

      <Card className="p-4">
        <div className="section-title mb-2">Coverage</div>
        <div className="flex flex-col gap-1.5">
          {data.coverage.map((item, index) => (
            <div
              key={`${item.check}-${index}`}
              className="flex flex-wrap items-center gap-2 border-b border-line-soft py-1.5 text-[11px]"
            >
              <Badge
                tone={item.status === 'ran' ? 'mint' : item.status === 'denied' ? 'danger' : 'warn'}
              >
                {item.status}
              </Badge>
              <span className="text-ink-soft">{item.check}</span>
              {item.count != null ? <span className="text-muted">({item.count})</span> : null}
              {item.reason ? <span className="text-muted">— {item.reason}</span> : null}
            </div>
          ))}
        </div>
        <div className="mt-2 text-[10px] text-muted">
          Generated {data.generatedAt}. Password hashes are never requested or returned.
        </div>
      </Card>

      <Modal
        open={Boolean(grantsFor)}
        onClose={() => {
          setGrantsFor(null);
          setGrants(null);
        }}
        title={grantsFor ? `Grants · ${userLabel(grantsFor)}` : 'Grants'}
        subtitle="Effective privileges from information_schema privilege tables."
        size="wide"
      >
        {grantsLoading ? (
          <div className="flex items-center gap-2 py-6 text-[12px] text-muted">
            <Spinner size={14} /> Loading grants…
          </div>
        ) : grants ? (
          <div className="flex flex-col gap-1.5">
            {grants.grants.map((grant, index) => (
              <div
                key={index}
                className="rounded-lg border border-line-soft bg-panel-2/50 px-3 py-2 font-mono text-[10.5px] text-ink-soft"
              >
                {grant}
              </div>
            ))}
          </div>
        ) : (
          <div className="text-[12px] text-muted">No grant data available.</div>
        )}
      </Modal>
    </div>
  );
}
