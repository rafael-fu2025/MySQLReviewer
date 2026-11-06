import { useId, useState } from 'react';
import { CheckCircle2, Eye, EyeOff, PlugZap, XCircle } from 'lucide-react';
import type {
  ConnectionProfile,
  DatabaseInfo,
  SslConfig,
  TestConnectionResult,
} from '@shared/types';
import { api, ApiError } from '@/lib/api';
import { notExecutedBadge } from '@/lib/copy';
import { Button, Checkbox, CopyButton, Field, IconButton, Input } from './ui';
import { cn } from '@/lib/utils';
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
  writeAccess: 'full' | 'locked';
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
    writeAccess: profile?.writeAccess ?? 'full',
  };
}

type FieldKey = 'name' | 'host' | 'port' | 'user';

const PORT_MIN = 1;
const PORT_MAX = 65535;

function validatePort(value: string): { port?: number; error?: string } {
  const trimmed = value.trim();
  if (!trimmed) return { error: 'Enter a port. 3306 is the MySQL default.' };
  if (!/^\d+$/.test(trimmed)) return { error: 'Port must be a whole number.' };
  const port = Number(trimmed);
  if (!Number.isFinite(port) || port < PORT_MIN || port > PORT_MAX) {
    return { error: `Port must be between ${PORT_MIN} and ${PORT_MAX}.` };
  }
  return { port };
}

function validateFields(form: FormState): {
  errors: Partial<Record<FieldKey, string>>;
  port?: number;
} {
  const errors: Partial<Record<FieldKey, string>> = {};
  if (!form.name.trim()) errors.name = 'Enter a name for this connection.';
  if (!form.host.trim()) errors.host = 'Enter a host name or IP address.';
  if (!form.user.trim()) errors.user = 'Enter the MySQL user name.';
  const portResult = validatePort(form.port);
  if (portResult.error) errors.port = portResult.error;
  return { errors, port: portResult.port };
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
  const passwordId = useId();
  const advancedId = useId();
  const [form, setForm] = useState<FormState>(() => initialState(profile));
  /**
   * Server-wide insights read every database on the server, so they cannot
   * be combined with a narrowed database scope. The value is derived rather
   * than stored twice, which keeps the control honest: what it shows is what
   * the server will be told.
   */
  const serverWideInsights = form.databaseScope === 'all' && form.allowServerWideInsights;
  const [showPassword, setShowPassword] = useState(false);
  const [advanced, setAdvanced] = useState(form.sslEnabled || Boolean(form.socketPath));
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<TestConnectionResult | null>(null);
  const [testDatabases, setTestDatabases] = useState<DatabaseInfo[]>([]);
  const [grantSql, setGrantSql] = useState<string | null>(null);
  const [grantBusy, setGrantBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<FieldKey, string>>>({});

  const set = <K extends keyof FormState>(key: K, value: FormState[K]): void => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  const clearFieldError = (key: FieldKey): void => {
    setFieldErrors((current) => {
      if (!current[key]) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  };

  /** Endpoint edits invalidate the database list returned by the last test. */
  const setEndpoint = (key: 'host' | 'port' | 'user' | 'socketPath', value: string): void => {
    set(key, value);
    if (key !== 'socketPath') clearFieldError(key);
    setTest(null);
    setTestDatabases([]);
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

  const buildPayload = (port: number) => ({
    name: form.name.trim(),
    host: form.host.trim(),
    port,
    user: form.user.trim(),
    ...(form.clearPassword ? { password: '' } : form.password ? { password: form.password } : {}),
    database: form.database.trim() || undefined,
    socketPath: form.socketPath.trim() || undefined,
    ssl: ssl(),
    rememberPassword: form.rememberPassword,
    databaseScope: form.databaseScope,
    allowedDatabases: form.databaseScope === 'selected' ? form.allowedDatabases : [],
    allowServerWideInsights: serverWideInsights,
    writeAccess: form.writeAccess,
  });

  const check = (): { ok: boolean; port?: number } => {
    const { errors, port } = validateFields(form);
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) {
      setError('Fix the highlighted connection fields before continuing.');
      return { ok: false };
    }
    setError(null);
    return { ok: true, port };
  };

  const runTest = async (): Promise<void> => {
    const validation = check();
    if (!validation.ok || validation.port === undefined) return;
    setTesting(true);
    setTest(null);
    setError(null);
    try {
      const payload = buildPayload(validation.port);
      const result = await api.post<TestConnectionResult>('/api/connections/test', {
        ...payload,
        includeDatabases: true,
        ...(profile && !form.password && !form.clearPassword ? { profileId: profile.id } : {}),
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
      setError('Save the connection first, then preview the least-privilege GRANT SQL.');
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
    const validation = check();
    if (!validation.ok || validation.port === undefined) return;
    if (form.databaseScope === 'selected' && form.allowedDatabases.length === 0) {
      setError('Select at least one database for a scoped connection.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const payload = buildPayload(validation.port);
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

  const databaseOptions = (
    testDatabases.length > 0
      ? testDatabases
      : form.allowedDatabases.map((name) => ({
          name,
          isSystem: false,
          tableCount: 0,
          viewCount: 0,
          sizeBytes: 0,
          collation: null,
        }))
  )
    .filter((database) => !database.isSystem)
    .map((database) => ({
      value: database.name,
      label: database.name,
      description:
        database.tableCount > 0
          ? `${database.tableCount} tables`
          : (database.collation ?? undefined),
      group: 'Databases',
    }));

  return (
    <form className="flex flex-col gap-4" onSubmit={save}>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Connection name" className="sm:col-span-2" error={fieldErrors.name}>
          <Input
            value={form.name}
            onChange={(event) => {
              set('name', event.target.value);
              clearFieldError('name');
            }}
            placeholder="XAMPP (local MariaDB)"
            aria-invalid={Boolean(fieldErrors.name)}
            autoFocus
          />
        </Field>
        <Field label="Host" error={fieldErrors.host}>
          <Input
            value={form.host}
            onChange={(event) => setEndpoint('host', event.target.value)}
            placeholder="127.0.0.1"
            aria-invalid={Boolean(fieldErrors.host)}
          />
        </Field>
        <Field label="Port" error={fieldErrors.port}>
          <Input
            value={form.port}
            onChange={(event) => setEndpoint('port', event.target.value)}
            onBlur={() => {
              const result = validatePort(form.port);
              if (result.error) {
                setFieldErrors((current) => ({ ...current, port: result.error }));
              }
            }}
            inputMode="numeric"
            placeholder="3306"
            aria-invalid={Boolean(fieldErrors.port)}
          />
        </Field>
        <Field label="MySQL user" error={fieldErrors.user}>
          <Input
            value={form.user}
            onChange={(event) => setEndpoint('user', event.target.value)}
            placeholder="root"
            aria-invalid={Boolean(fieldErrors.user)}
          />
        </Field>
        <div className="field">
          <label className="field-label" htmlFor={passwordId}>
            Password
          </label>
          <div className="flex items-center gap-1">
            <Input
              id={passwordId}
              className="min-w-0 flex-1 font-mono"
              type={showPassword ? 'text' : 'password'}
              value={form.password}
              onChange={(event) => {
                const value = event.target.value;
                set('password', value);
                // Typing a new password overrides a pending "clear the saved password".
                if (value) set('clearPassword', false);
              }}
              placeholder={profile?.hasPassword ? '••••••••' : 'empty for XAMPP root'}
            />
            <IconButton
              type="button"
              label={showPassword ? 'Hide password' : 'Show password'}
              aria-pressed={showPassword}
              onClick={() => setShowPassword((value) => !value)}
            >
              {showPassword ? <EyeOff size={14} /> : <Eye size={14} />}
            </IconButton>
          </div>
          {profile?.hasPassword && !form.password && !form.clearPassword ? (
            <span className="field-hint">Leave blank to keep the saved password.</span>
          ) : null}
        </div>
        <Field label="Default database">
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
              onChange={(value) => {
                set('clearPassword', value);
                if (value) set('password', '');
              }}
            />
          ) : null}
        </div>
      </div>

      <div className="rounded-xl border border-line-soft bg-panel-2 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <div>
            <div className="text-xs font-semibold">Database access</div>
          </div>
          <div className="ml-auto flex gap-1">
            <button
              type="button"
              className={cn('badge cursor-pointer', form.databaseScope === 'all' && 'badge-ember')}
              onClick={() =>
                setForm((current) => ({
                  ...current,
                  databaseScope: 'all',
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
              <div className="text-2xs text-muted">
                Test the connection to load the server’s databases.
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="rounded-xl border border-line-soft bg-panel-2 p-3">
        <div className="text-xs font-semibold">Permissions</div>
        <div className="mt-2 flex flex-col gap-2">
          <Checkbox
            label="Allow server-wide performance and security insights"
            checked={serverWideInsights}
            disabled={form.databaseScope === 'selected'}
            onChange={(value) => set('allowServerWideInsights', value)}
          />
          <div className="text-2xs leading-4 text-muted">
            {form.databaseScope === 'selected'
              ? 'Server-wide insights read every database on the server, so they stay off while this connection is limited to selected databases.'
              : 'Grants, not this list, are the security boundary.'}
          </div>
          <Checkbox
            label="Allow members to write through this connection"
            checked={form.writeAccess === 'full'}
            onChange={(value) => set('writeAccess', value ? 'full' : 'locked')}
          />
          <div className="text-2xs leading-4 text-muted">
            {form.writeAccess === 'full'
              ? 'Members can unlock writes on this connection for 15 minutes, as they can on any other.'
              : 'This connection is read-only for members: they cannot run write statements on it, and they cannot reveal masked values through it. You keep full write access, and you can change this at any time.'}
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
              <span className="text-2xs text-muted">
                Save the connection first to generate SQL for a new user.
              </span>
            ) : null}
          </div>
          {grantSql ? (
            <div className="rounded-lg border border-line-soft bg-canvas p-2">
              <div className="mb-1 flex items-center gap-2">
                <span className="mono-label">Least-privilege SQL · {notExecutedBadge}</span>
                <CopyButton text={grantSql} label="Copy" />
              </div>
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap font-mono text-2xs text-ink-soft">
                {grantSql}
              </pre>
            </div>
          ) : null}
        </div>
      </div>

      <button
        type="button"
        className="flex w-fit items-center gap-1 text-2xs text-muted hover:text-ink"
        onClick={() => setAdvanced((value) => !value)}
        aria-expanded={advanced}
        aria-controls={advancedId}
      >
        {advanced ? 'Hide' : 'Show'} socket & SSL options
      </button>

      {advanced ? (
        <div
          id={advancedId}
          className="grid grid-cols-1 gap-3 rounded-xl border border-line-soft bg-panel-2 p-3 sm:grid-cols-2"
        >
          <Field
            label="Socket path"
            hint="Optional. Used instead of host/port when set."
            className="sm:col-span-2"
          >
            <Input
              className="font-mono text-2xs"
              value={form.socketPath}
              onChange={(event) => setEndpoint('socketPath', event.target.value)}
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
                  label="Verify the server certificate"
                  checked={form.rejectUnauthorized}
                  onChange={(value) => set('rejectUnauthorized', value)}
                />
              </div>
              <Field label="CA file or PEM">
                <Input
                  className="font-mono text-2xs"
                  value={form.ca}
                  onChange={(event) => set('ca', event.target.value)}
                  placeholder="C:/certs/ca.pem"
                />
              </Field>
              <Field label="Client certificate or PEM">
                <Input
                  className="font-mono text-2xs"
                  value={form.cert}
                  onChange={(event) => set('cert', event.target.value)}
                  placeholder="C:/certs/client-cert.pem"
                />
              </Field>
              <Field label="Client key or PEM" className="sm:col-span-2">
                <Input
                  className="font-mono text-2xs"
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
        <div className={cn('callout flex items-start gap-2', test.ok ? 'mint' : 'danger')}>
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
              <span className="font-mono text-2xs text-muted">
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
          icon={<PlugZap size={13} />}
          onClick={runTest}
          loading={testing}
        >
          Test
        </Button>
        <Button type="submit" variant="primary" loading={saving}>
          {profile ? 'Save connection' : 'Add connection'}
        </Button>
      </div>
    </form>
  );
}
