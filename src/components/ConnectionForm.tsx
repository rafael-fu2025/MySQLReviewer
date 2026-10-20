import { useState } from 'react';
import { CheckCircle2, Eye, EyeOff, PlugZap, XCircle } from 'lucide-react';
import type {
  ConnectionProfile,
  DatabaseInfo,
  SslConfig,
  TestConnectionResult,
} from '@shared/types';
import { api, ApiError } from '@/lib/api';
import {
  Button,
  Checkbox,
  CopyButton,
  Field,
  Input,
  Spinner,
  cn,
} from './ui';
import { MultiSelect } from './Combobox';

interface FormState {
  name: string;
  host: string;
  port: string;
  user: string;
  password: string;
  database: string;
  socketPath: string;
  rememberPassword: boolean;
  clearPassword: boolean;
  sslEnabled: boolean;
  rejectUnauthorized: boolean;
  ca: string;
  cert: string;
  key: string;
  databaseScope: 'all' | 'selected';
  allowedDatabases: string[];
  allowServerWideInsights: boolean;
}

function initialState(profile?: ConnectionProfile | null): FormState {
  return {
    name: profile?.name ?? 'XAMPP (local MariaDB)',
    host: profile?.host ?? '127.0.0.1',
    port: String(profile?.port ?? 3306),
    user: profile?.user ?? 'root',
    password: '',
    database: profile?.database ?? '',
    socketPath: profile?.socketPath ?? '',
    rememberPassword: profile?.rememberPassword ?? true,
    clearPassword: false,
    sslEnabled: Boolean(profile?.ssl?.enabled),
    rejectUnauthorized: profile?.ssl?.rejectUnauthorized !== false,
    ca: profile?.ssl?.ca ?? '',
    cert: profile?.ssl?.cert ?? '',
    key: profile?.ssl?.key ?? '',
    databaseScope: profile?.databaseScope ?? 'all',
    allowedDatabases: profile?.allowedDatabases ?? [],
    allowServerWideInsights: profile?.allowServerWideInsights ?? true,
  };
}

export function ConnectionForm({
  profile,
  onSaved,
  onCancel,
}: {
  profile?: ConnectionProfile | null;
  onSaved: (profile: ConnectionProfile) => void;
  onCancel?: () => void;
}) {
  const [form, setForm] = useState<FormState>(() => initialState(profile));
  const [showPassword, setShowPassword] = useState(false);
  const [advanced, setAdvanced] = useState(form.sslEnabled || Boolean(form.socketPath));
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<TestConnectionResult | null>(null);
  const [testDatabases, setTestDatabases] = useState<DatabaseInfo[]>([]);
  const [grantSql, setGrantSql] = useState<string | null>(null);
  const [grantBusy, setGrantBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]): void => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  const ssl = (): SslConfig | undefined =>
    form.sslEnabled
      ? {
          enabled: true,
          rejectUnauthorized: form.rejectUnauthorized,
          ca: form.ca.trim() || undefined,
          cert: form.cert.trim() || undefined,
          key: form.key.trim() || undefined,
        }
      : undefined;

  const buildPayload = () => ({
    name: form.name.trim(),
    host: form.host.trim(),
    port: Number(form.port),
    user: form.user.trim(),
    ...(form.clearPassword
      ? { password: '' }
      : form.password
        ? { password: form.password }
        : {}),
    database: form.database.trim() || undefined,
    socketPath: form.socketPath.trim() || undefined,
    ssl: ssl(),
    rememberPassword: form.rememberPassword,
    databaseScope: form.databaseScope,
    allowedDatabases: form.databaseScope === 'selected' ? form.allowedDatabases : [],
    allowServerWideInsights: form.allowServerWideInsights,
  });

  const runTest = async (): Promise<void> => {
    setTesting(true);
    setTest(null);
    setError(null);
    try {
      const payload = buildPayload();
      const result = await api.post<TestConnectionResult>('/api/connections/test', {
        ...payload,
        includeDatabases: true,
        ...(profile && !form.password && !form.clearPassword
          ? { profileId: profile.id }
          : {}),
      });
      setTest(result);
      if (result.ok && result.databases) {
        setTestDatabases(result.databases);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setTesting(false);
    }
  };

  const previewGrant = async (): Promise<void> => {
    if (!profile) {
      setError('Save the profile first, then preview the least-privilege GRANT SQL.');
      return;
    }
    if (form.allowedDatabases.length === 0) {
      setError('Select at least one database before generating the GRANT SQL.');
      return;
    }
    setGrantBusy(true);
    setError(null);
    try {
      const result = await api.post<{ sql: string; warnings: string[] }>(
        `/api/connections/${profile.id}/grant-sql`,
        {
          user: 'mylens_app',
          host: 'localhost',
          databases: form.allowedDatabases,
          privileges: ['SELECT', 'SHOW VIEW'],
        },
      );
      setGrantSql(result.sql);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setGrantBusy(false);
    }
  };

  const save = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (form.databaseScope === 'selected' && form.allowedDatabases.length === 0) {
      setError('Select at least one database for a scoped connection.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const payload = buildPayload();
      const saved = profile
        ? await api.put<ConnectionProfile>(`/api/connections/${profile.id}`, payload)
        : await api.post<ConnectionProfile>('/api/connections', payload);
      onSaved(saved);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const databaseOptions = (testDatabases.length > 0
    ? testDatabases
    : form.allowedDatabases.map((name) => ({
        name,
        isSystem: false,
        tableCount: 0,
        viewCount: 0,
        sizeBytes: 0,
        collation: null,
      })))
    .filter((database) => !database.isSystem)
    .map((database) => ({
      value: database.name,
      label: database.name,
      description:
        database.tableCount > 0
          ? `${database.tableCount} tables`
          : database.collation ?? undefined,
      group: 'Databases',
    }));

  return (
    <form className="flex flex-col gap-4" onSubmit={save}>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Connection name" className="sm:col-span-2">
          <Input
            value={form.name}
            onChange={(event) => set('name', event.target.value)}
            placeholder="XAMPP (local MariaDB)"
            autoFocus
          />
        </Field>
        <Field label="Host">
          <Input
            value={form.host}
            onChange={(event) => set('host', event.target.value)}
            placeholder="127.0.0.1"
          />
        </Field>
        <Field label="Port">
          <Input
            value={form.port}
            onChange={(event) => set('port', event.target.value)}
            inputMode="numeric"
            placeholder="3306"
          />
        </Field>
        <Field label="MySQL user">
          <Input
            value={form.user}
            onChange={(event) => set('user', event.target.value)}
            placeholder="root"
          />
        </Field>
        <Field
          label="Password"
          hint={
            profile?.hasPassword && !form.password && !form.clearPassword
              ? 'Leave blank to keep the saved password.'
              : 'The password is encrypted at rest when remembered.'
          }
        >
          <div className="relative">
            <Input
              className="pr-10 font-mono"
              type={showPassword ? 'text' : 'password'}
              value={form.password}
              onChange={(event) => set('password', event.target.value)}
              placeholder={profile?.hasPassword ? '••••••••' : 'empty for XAMPP root'}
            />
            <button
              type="button"
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted hover:text-ink"
              onClick={() => setShowPassword((value) => !value)}
              aria-label={showPassword ? 'Hide password' : 'Show password'}
            >
              {showPassword ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
        </Field>
        <Field label="Default database" hint="Optional. The workspace database selector still works.">
          <Input
            value={form.database}
            onChange={(event) => set('database', event.target.value)}
            placeholder="(none)"
          />
        </Field>
        <div className="flex flex-col justify-end gap-2">
          <Checkbox
            label="Remember password (encrypted with a local key)"
            checked={form.rememberPassword}
            onChange={(value) => set('rememberPassword', value)}
          />
          {profile?.hasPassword ? (
            <Checkbox
              label="Clear the saved password"
              checked={form.clearPassword}
              onChange={(value) => set('clearPassword', value)}
            />
          ) : null}
        </div>
      </div>

      <div className="rounded-xl border border-line-soft bg-panel-2/40 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <div>
            <div className="text-[12px] font-semibold">Database access</div>
            <div className="text-[10.5px] text-muted">
              Limit which databases this profile can see and query.
            </div>
          </div>
          <div className="ml-auto flex gap-1">
            <button
              type="button"
              className={cn(
                'badge cursor-pointer',
                form.databaseScope === 'all' && 'badge-ember',
              )}
              onClick={() =>
                setForm((current) => ({
                  ...current,
                  databaseScope: 'all',
                  allowServerWideInsights: true,
                }))
              }
            >
              All databases
            </button>
            <button
              type="button"
              className={cn(
                'badge cursor-pointer',
                form.databaseScope === 'selected' && 'badge-ember',
              )}
              onClick={() =>
                setForm((current) => ({
                  ...current,
                  databaseScope: 'selected',
                  allowServerWideInsights:
                    current.databaseScope === 'selected'
                      ? current.allowServerWideInsights
                      : false,
                }))
              }
            >
              Only selected
            </button>
          </div>
        </div>

        {form.databaseScope === 'selected' ? (
          <div className="mt-3 flex flex-col gap-2">
            <MultiSelect
              options={databaseOptions}
              values={form.allowedDatabases}
              onChange={(values) => set('allowedDatabases', values)}
              placeholder="Select allowed databases…"
              searchPlaceholder="Search databases…"
              showSelectAll
            />
            {testDatabases.length === 0 ? (
              <div className="text-[10px] text-muted">
                Test the connection to load the server’s databases. The saved selection
                remains editable.
              </div>
            ) : null}
            <Checkbox
              label="Allow server-wide performance and security insights"
              checked={form.allowServerWideInsights}
              onChange={(value) => set('allowServerWideInsights', value)}
            />
            <div className="text-[10px] leading-4 text-muted">
              The profile allowlist is a workflow guardrail. A restricted MySQL user and
              grants are the real security boundary.
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                loading={grantBusy}
                onClick={() => void previewGrant()}
              >
                Preview GRANT SQL
              </Button>
              {!profile ? (
                <span className="text-[10px] text-muted">
                  Save the profile first to generate SQL for a new user.
                </span>
              ) : null}
            </div>
            {grantSql ? (
              <div className="rounded-lg border border-line-soft bg-canvas/50 p-2">
                <div className="mb-1 flex items-center gap-2">
                  <span className="mono-label">Least-privilege SQL · not executed</span>
                  <CopyButton text={grantSql} label="Copy" />
                </div>
                <pre className="max-h-40 overflow-auto whitespace-pre-wrap font-mono text-[10px] text-ink-soft">
                  {grantSql}
                </pre>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="mt-2 text-[10.5px] text-muted">
            The database selector shows every database the MySQL user can see.
          </div>
        )}
      </div>

      <button
        type="button"
        className="flex w-fit items-center gap-1 text-[11px] text-muted hover:text-ink"
        onClick={() => setAdvanced((value) => !value)}
      >
        {advanced ? 'Hide' : 'Show'} socket & SSL options
      </button>

      {advanced ? (
        <div className="grid grid-cols-1 gap-3 rounded-xl border border-line-soft bg-panel-2/40 p-3 sm:grid-cols-2">
          <Field
            label="Socket path"
            hint="Optional. Used instead of host/port when set."
            className="sm:col-span-2"
          >
            <Input
              className="font-mono text-[11.5px]"
              value={form.socketPath}
              onChange={(event) => set('socketPath', event.target.value)}
              placeholder="C:/xampp/mysql/mysql.sock"
            />
          </Field>
          <div className="sm:col-span-2">
            <Checkbox
              label="Use SSL/TLS"
              checked={form.sslEnabled}
              onChange={(value) => set('sslEnabled', value)}
            />
          </div>
          {form.sslEnabled ? (
            <>
              <div className="sm:col-span-2">
                <Checkbox
                  label="Verify the server certificate (rejectUnauthorized)"
                  checked={form.rejectUnauthorized}
                  onChange={(value) => set('rejectUnauthorized', value)}
                />
              </div>
              <Field label="CA file or PEM">
                <Input
                  className="font-mono text-[11px]"
                  value={form.ca}
                  onChange={(event) => set('ca', event.target.value)}
                  placeholder="C:/certs/ca.pem"
                />
              </Field>
              <Field label="Client certificate or PEM">
                <Input
                  className="font-mono text-[11px]"
                  value={form.cert}
                  onChange={(event) => set('cert', event.target.value)}
                  placeholder="C:/certs/client-cert.pem"
                />
              </Field>
              <Field label="Client key or PEM" className="sm:col-span-2">
                <Input
                  className="font-mono text-[11px]"
                  value={form.key}
                  onChange={(event) => set('key', event.target.value)}
                  placeholder="C:/certs/client-key.pem"
                />
              </Field>
            </>
          ) : null}
        </div>
      ) : null}

      {error ? (
        <div className="callout danger flex items-start gap-2">
          <XCircle size={14} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}

      {test ? (
        <div
          className={cn(
            'callout flex items-start gap-2',
            test.ok ? 'mint' : 'danger',
          )}
        >
          {test.ok ? (
            <CheckCircle2 size={15} className="mt-0.5 shrink-0 text-mint" />
          ) : (
            <XCircle size={15} className="mt-0.5 shrink-0 text-danger" />
          )}
          <div className="flex flex-col gap-1">
            <span className="font-semibold">
              {test.ok ? 'Connection succeeded' : 'Connection failed'}
            </span>
            {test.ok && test.server ? (
              <span className="font-mono text-[10.5px] text-muted">
                {test.server.version} · {test.server.flavor} · {test.latencyMs} ms
                {test.server.uptimeSeconds
                  ? ` · uptime ${Math.round(test.server.uptimeSeconds / 60)} min`
                  : ''}
              </span>
            ) : (
              <span>{test.error}</span>
            )}
          </div>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-end gap-2">
        {onCancel ? (
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
        <Button
          type="button"
          variant="secondary"
          icon={testing ? <Spinner size={13} /> : <PlugZap size={13} />}
          onClick={runTest}
          loading={testing}
        >
          Test connection
        </Button>
        <Button type="submit" variant="primary" loading={saving}>
          {profile ? 'Save changes' : 'Add connection'}
        </Button>
      </div>
    </form>
  );
}
