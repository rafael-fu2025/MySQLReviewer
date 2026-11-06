import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Brain,
  CheckCircle2,
  Database,
  Edit3,
  Laptop,
  Plus,
  Server,
  ShieldCheck,
  Sparkles,
  Star,
  Sun,
  Trash2,
  Zap,
} from 'lucide-react';
import type {
  AiProvider,
  AiProviderTestResult,
  AppSettings,
  ConnectionProfile,
  ReportSummary,
  ThemePreference,
} from '@shared/types';
import { APP_VERSION } from '@shared/types';
import { AGENT_TOOLS } from '@shared/agent-tools';
import { useAppStore } from '@/store/app-store';
import { api } from '@/lib/api';
import {
  compatLine,
  deleteConnectionConfirmLabel,
  deleteConnectionMessage,
  deleteConnectionTitle,
} from '@/lib/copy';
import { formatRelative } from '@/lib/format';
import { ConnectionForm } from '@/components/ConnectionForm';
import { ProviderForm } from '@/components/ProviderForm';
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  Field,
  Input,
  Modal,
  PageHeader,
  Spinner,
  Switch,
  Tabs,
  Textarea,
} from '@/components/ui';
import { cn } from '@/lib/utils';
import { Combobox } from '@/components/Combobox';

export type SettingsTab = 'connections' | 'ai' | 'review' | 'safety' | 'appearance' | 'data';

const TAB_IDS: SettingsTab[] = ['connections', 'ai', 'review', 'safety', 'appearance', 'data'];

function parseTab(value: string | null): SettingsTab {
  return TAB_IDS.includes(value as SettingsTab) ? (value as SettingsTab) : 'connections';
}

export type NumericField =
  'rowLimit' | 'queryTimeoutMs' | 'cellMaxChars' | 'aiContextChars' | 'historyLimit';

const NUMERIC_FIELDS: NumericField[] = [
  'rowLimit',
  'queryTimeoutMs',
  'cellMaxChars',
  'aiContextChars',
  'historyLimit',
];

const NUMERIC_RULES: Record<NumericField, { label: string; min: number; max: number }> = {
  rowLimit: { label: 'Row cap', min: 1, max: 10_000 },
  queryTimeoutMs: { label: 'Query timeout', min: 1_000, max: 300_000 },
  cellMaxChars: { label: 'Cell size cap', min: 256, max: 1_000_000 },
  aiContextChars: { label: 'AI context budget', min: 2_000, max: 200_000 },
  historyLimit: { label: 'History entries', min: 50, max: 5_000 },
};

function numericDraftsOf(settings: AppSettings): Record<NumericField, string> {
  return {
    rowLimit: String(settings.rowLimit),
    queryTimeoutMs: String(settings.queryTimeoutMs),
    cellMaxChars: String(settings.cellMaxChars),
    aiContextChars: String(settings.aiContextChars),
    historyLimit: String(settings.historyLimit),
  };
}

function validateNumeric(field: NumericField, raw: string): { value?: number; error?: string } {
  const rule = NUMERIC_RULES[field];
  const trimmed = raw.trim();
  if (!trimmed) return { error: `${rule.label} is required.` };
  if (!/^\d+$/.test(trimmed)) return { error: `${rule.label} must be a whole number.` };
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < rule.min || value > rule.max) {
    return {
      error: `${rule.label} must be between ${rule.min.toLocaleString()} and ${rule.max.toLocaleString()}.`,
    };
  }
  return { value };
}

/**
 * The settings that travel through the draft. The theme is applied
 * immediately and the write-unlock switch has its own action, so neither
 * belongs to the draft.
 */
function draftFingerprint(settings: AppSettings): string {
  const { theme: _theme, writeUnlockEnabled: _writeUnlockEnabled, ...rest } = settings;
  return JSON.stringify(rest);
}

export interface SettingsHeaderProps {
  tab: SettingsTab;
  profileCount: number;
  providerCount: number;
  onTabChange: (tab: SettingsTab) => void;
}

/**
 * The page heading and the section switcher.
 *
 * They live in one block because they belong together: the tab strip is the
 * only way to leave a section, so it must never scroll away from the
 * heading. The block is pinned to the top of the scroll container, which keeps
 * the switcher reachable on a long tab.
 */
export function SettingsHeader({
  tab,
  profileCount,
  providerCount,
  onTabChange,
}: SettingsHeaderProps) {
  return (
    <div className="sticky top-0 z-20 -mx-6 flex flex-col gap-4 bg-canvas px-6 pt-3 pb-3 max-[641px]:-mx-3 max-[641px]:px-3 relative before:absolute before:inset-x-0 before:-top-6 before:h-6 before:content-[''] before:bg-canvas max-[641px]:before:-top-3 max-[641px]:before:h-3">
      <PageHeader title="Settings" />

      <Tabs
        items={[
          {
            id: 'connections',
            label: 'Connections',
            count: profileCount,
            icon: <Database size={12} />,
          },
          {
            id: 'ai',
            label: 'AI providers',
            count: providerCount,
            icon: <Sparkles size={12} />,
          },
          { id: 'review', label: 'Review', icon: <Brain size={12} /> },
          { id: 'safety', label: 'Safety', icon: <ShieldCheck size={12} /> },
          { id: 'appearance', label: 'Appearance', icon: <Sun size={12} /> },
          { id: 'data', label: 'Data & about', icon: <Server size={12} /> },
        ]}
        value={tab}
        onChange={onTabChange}
      />
    </div>
  );
}

export interface SafetyTabProps {
  writeUnlockEnabled: boolean;
  writeUnlockBusy: boolean;
  savingSettings: boolean;
  draft: AppSettings;
  numericDrafts: Record<NumericField, string>;
  numericErrors: Partial<Record<NumericField, string>>;
  onToggleWriteUnlock: (enabled: boolean) => void;
  onToggleMaskSensitive: (enabled: boolean) => void;
  onToggleAgentTool: (name: string) => void;
  mcpServersJson: string;
  mcpError: string | null;
  onMcpServersChange: (json: string) => void;
  onMcpServersApply: () => void;
  onNumericChange: (field: NumericField, raw: string) => void;
  onNumericBlur: (field: NumericField) => void;
  onSave: () => void;
}

/**
 * The Safety section: the read-only model, the write-unlock switch, the
 * masking switch and the query limits.
 */
export function SafetyTab({
  writeUnlockEnabled,
  writeUnlockBusy,
  savingSettings,
  draft,
  numericDrafts,
  numericErrors,
  onToggleWriteUnlock,
  onToggleMaskSensitive,
  onToggleAgentTool,
  mcpServersJson,
  mcpError,
  onMcpServersChange,
  onMcpServersApply,
  onNumericChange,
  onNumericBlur,
  onSave,
}: SafetyTabProps) {
  return (
    <div className="flex flex-col gap-3">
      <Card className="p-4">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <ShieldCheck size={15} className="text-mint" />
          <div className="section-title">Read-only by default</div>
        </div>
        <div className="callout mint text-2xs">
          Read-only statements run freely. DML, DDL, and administrative statements require typing{' '}
          <span className="font-mono">UNLOCK WRITES</span> for a 15-minute per-connection window.
        </div>
      </Card>
      <Card className="p-4">
        <div className="section-title mb-3">Write unlocking</div>
        <div className="flex items-start justify-between gap-4 rounded-xl border border-line-soft bg-panel-2 p-3">
          <div>
            <div className="text-xs font-semibold">Allow write unlocking</div>
            <div className="mt-0.5 max-w-xl text-2xs leading-4 text-muted">
              {writeUnlockEnabled
                ? 'Accounts can unlock writes for their own connection for 15 minutes. Turn this off to make the app read-only for everybody.'
                : 'Write unlocking is off for every account, administrators included. No account can unlock writes or reveal masked values.'}
            </div>
          </div>
          <Switch
            label="Allow write unlocking"
            checked={writeUnlockEnabled}
            disabled={writeUnlockBusy}
            onChange={onToggleWriteUnlock}
          />
        </div>
      </Card>
      <Card className="p-4">
        <div className="section-title mb-3">Sensitive data</div>
        <div className="flex items-start justify-between gap-4 rounded-xl border border-line-soft bg-panel-2 p-3">
          <div>
            <div className="text-xs font-semibold">Mask sensitive columns</div>
            <div className="mt-0.5 max-w-xl text-2xs leading-4 text-muted">
              Masks credential-like columns in results; they can be revealed per statement after a
              confirmation. Not a substitute for grants.
            </div>
          </div>
          <Switch
            label="Mask sensitive columns"
            checked={draft.maskSensitiveColumns}
            onChange={onToggleMaskSensitive}
          />
        </div>
      </Card>
      <Card className="p-4">
        <div className="section-title mb-1">Agent tools</div>
        <div className="mb-3 max-w-xl text-2xs leading-4 text-muted">
          What the AI assistant may do on its own when it works as an agent. Every tool runs behind
          the same guards as the app: read-only scope, masking, row caps and the write lock.
          Switched-off tools are removed server-side, so the model never sees them.
        </div>
        <div className="flex flex-col gap-2">
          {AGENT_TOOLS.map((tool) => {
            const disabled = draft.disabledAgentTools?.includes(tool.name) ?? false;
            return (
              <div
                key={tool.name}
                className="flex items-start justify-between gap-4 rounded-xl border border-line-soft bg-panel-2 p-3"
              >
                <div className="min-w-0">
                  <div className="text-xs font-semibold">
                    {tool.label}{' '}
                    <span className="font-mono text-2xs font-normal text-muted">{tool.name}</span>
                  </div>
                  <div className="mt-0.5 max-w-xl text-2xs leading-4 text-muted">
                    {tool.description}
                  </div>
                </div>
                <Switch
                  label={`${tool.label} available to the agent`}
                  checked={!disabled}
                  onChange={() => onToggleAgentTool(tool.name)}
                />
              </div>
            );
          })}
        </div>
      </Card>
      <Card className="p-4">
        <div className="section-title mb-1">MCP servers</div>
        <div className="mb-3 max-w-xl text-2xs leading-4 text-muted">
          Optional local Model Context Protocol servers the agent may call over stdio. Each entry:{' '}
          <span className="font-mono">{`{ "name": "docs", "command": "uvx", "args": ["mcp-server-fetch"], "allowedTools": ["fetch"] }`}</span>
          . The command runs locally with a scrubbed environment; a server that fails to start is
          skipped. At most 3 servers.
        </div>
        <Textarea
          rows={7}
          className="min-h-[110px] font-mono text-2xs"
          value={mcpServersJson}
          onChange={(event) => onMcpServersChange(event.target.value)}
          onBlur={onMcpServersApply}
          aria-label="MCP servers JSON"
          spellCheck={false}
        />
        {mcpError ? (
          <div className="callout danger mt-2 text-2xs" role="alert">
            {mcpError}
          </div>
        ) : null}
      </Card>
      <Card className="p-4">
        <div className="section-title mb-3">Query limits</div>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field
            label="Row cap"
            hint="Applied as sql_select_limit for interactive queries. 1–10,000."
            error={numericErrors.rowLimit}
          >
            <Input
              type="number"
              inputMode="numeric"
              value={numericDrafts.rowLimit}
              onChange={(event) => onNumericChange('rowLimit', event.target.value)}
              onBlur={() => onNumericBlur('rowLimit')}
              aria-invalid={Boolean(numericErrors.rowLimit)}
            />
          </Field>
          <Field
            label="Query timeout (ms)"
            hint="Server-side max_statement_time / max_execution_time, plus client timeout."
            error={numericErrors.queryTimeoutMs}
          >
            <Input
              type="number"
              inputMode="numeric"
              value={numericDrafts.queryTimeoutMs}
              onChange={(event) => onNumericChange('queryTimeoutMs', event.target.value)}
              onBlur={() => onNumericBlur('queryTimeoutMs')}
              aria-invalid={Boolean(numericErrors.queryTimeoutMs)}
            />
          </Field>
          <Field label="Cell size cap (characters)" error={numericErrors.cellMaxChars}>
            <Input
              type="number"
              inputMode="numeric"
              value={numericDrafts.cellMaxChars}
              onChange={(event) => onNumericChange('cellMaxChars', event.target.value)}
              onBlur={() => onNumericBlur('cellMaxChars')}
              aria-invalid={Boolean(numericErrors.cellMaxChars)}
            />
          </Field>
          <Field
            label="History entries"
            hint="Server-side query history cap. 50–5,000."
            error={numericErrors.historyLimit}
          >
            <Input
              type="number"
              inputMode="numeric"
              value={numericDrafts.historyLimit}
              onChange={(event) => onNumericChange('historyLimit', event.target.value)}
              onBlur={() => onNumericBlur('historyLimit')}
              aria-invalid={Boolean(numericErrors.historyLimit)}
            />
          </Field>
        </div>
      </Card>
      {/* The button saves the whole tab — write unlocking, masking and the
          query limits — so it sits in a page-level action row, not inside
          the card that holds the four limit fields. */}
      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line-soft pt-3">
        <Button variant="primary" loading={savingSettings} onClick={onSave}>
          Save safety settings
        </Button>
      </div>
    </div>
  );
}

export function SettingsPage() {
  const [params, setParams] = useSearchParams();
  const tab = parseTab(params.get('tab'));

  const profiles = useAppStore((state) => state.profiles);
  const providers = useAppStore((state) => state.providers);
  const settings = useAppStore((state) => state.settings);
  // Absent in a settings file written before the switch existed: enabled.
  const writeUnlockEnabled = settings.writeUnlockEnabled !== false;
  const theme = useAppStore((state) => state.theme);
  const activeProfileId = useAppStore((state) => state.activeProfileId);
  const boot = useAppStore((state) => state.boot);
  const detectedXampp = useAppStore((state) => state.detectedXampp);
  const refreshProfiles = useAppStore((state) => state.refreshProfiles);
  const refreshProviders = useAppStore((state) => state.refreshProviders);
  const refreshSettings = useAppStore((state) => state.refreshSettings);
  const updateSettings = useAppStore((state) => state.updateSettings);
  const setTheme = useAppStore((state) => state.setTheme);
  const disconnect = useAppStore((state) => state.disconnect);
  const toast = useAppStore((state) => state.toast);

  const [connectionModal, setConnectionModal] = useState<{
    open: boolean;
    profile: ConnectionProfile | null;
  }>({ open: false, profile: null });
  const [deletingConnection, setDeletingConnection] = useState<ConnectionProfile | null>(null);
  const [providerModal, setProviderModal] = useState<{
    open: boolean;
    provider: AiProvider | null;
  }>({ open: false, provider: null });
  const [deletingProvider, setDeletingProvider] = useState<AiProvider | null>(null);
  const [testingProvider, setTestingProvider] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [reports, setReports] = useState<ReportSummary[]>([]);
  const [draft, setDraft] = useState<AppSettings>(settings);
  // The MCP server list is edited as JSON text and applied to the draft on
  // blur, so a half-typed line never travels to the server.
  const [mcpServersJson, setMcpServersJson] = useState<string>(() =>
    JSON.stringify(settings.mcpServers ?? [], null, 2),
  );
  const [mcpError, setMcpError] = useState<string | null>(null);
  const [numericDrafts, setNumericDrafts] = useState<Record<NumericField, string>>(() =>
    numericDraftsOf(settings),
  );
  const [numericErrors, setNumericErrors] = useState<Partial<Record<NumericField, string>>>({});
  const [savingSettings, setSavingSettings] = useState(false);
  const [writeUnlockBusy, setWriteUnlockBusy] = useState(false);
  const [confirmClearHistory, setConfirmClearHistory] = useState(false);
  const [clearingHistory, setClearingHistory] = useState(false);
  const appliedSettingsRef = useRef(draftFingerprint(settings));

  useEffect(() => {
    const snapshot = draftFingerprint(settings);
    if (snapshot === appliedSettingsRef.current) return;
    const previous = appliedSettingsRef.current;
    appliedSettingsRef.current = snapshot;
    // A theme change rewrites settings without touching these fields; keep unsaved edits intact.
    if (draftFingerprint(draft) !== previous) return;
    setDraft(settings);
    setNumericDrafts(numericDraftsOf(settings));
    setNumericErrors({});
  }, [draft, settings]);

  useEffect(() => {
    void api
      .get<ReportSummary[]>('/api/reports')
      .then(setReports)
      .catch(() => setReports([]));
  }, []);

  const setTab = (next: SettingsTab): void => {
    const copy = new URLSearchParams(params);
    copy.set('tab', next);
    setParams(copy);
  };

  const setNumericError = (field: NumericField, error: string | undefined): void => {
    setNumericErrors((current) => {
      const next = { ...current };
      if (error) next[field] = error;
      else delete next[field];
      return next;
    });
  };

  const updateNumeric = (field: NumericField, raw: string): void => {
    setNumericDrafts((current) => ({ ...current, [field]: raw }));
    const result = validateNumeric(field, raw);
    setNumericError(field, result.error);
    if (result.value !== undefined) {
      setDraft((current) => ({ ...current, [field]: result.value }));
    }
  };

  const blurNumeric = (field: NumericField): void => {
    setNumericError(field, validateNumeric(field, numericDrafts[field]).error);
  };

  const saveSettings = async (): Promise<void> => {
    const errors: Partial<Record<NumericField, string>> = {};
    const numeric: Partial<Record<NumericField, number>> = {};
    for (const field of NUMERIC_FIELDS) {
      const result = validateNumeric(field, numericDrafts[field]);
      if (result.error) errors[field] = result.error;
      else if (result.value !== undefined) numeric[field] = result.value;
    }
    setNumericErrors(errors);
    if (Object.keys(errors).length > 0) {
      toast('Fix the highlighted numbers before saving.', 'error');
      return;
    }
    setSavingSettings(true);
    try {
      // The write-unlock switch has its own action; it must not ride along with
      // the draft.
      const { writeUnlockEnabled: _writeUnlockEnabled, ...draftSettings } = draft;
      await updateSettings({ ...draftSettings, ...numeric, theme });
      toast('Settings saved.', 'success');
      const saved = useAppStore.getState().settings;
      appliedSettingsRef.current = draftFingerprint(saved);
      setDraft(saved);
      setNumericDrafts(numericDraftsOf(saved));
      setNumericErrors({});
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setSavingSettings(false);
    }
  };

  /**
   * The global write-unlock switch. Turning it off makes the whole app
   * read-only — administrators included — so it is applied on its own instead
   * of riding along with the settings draft.
   */
  const toggleWriteUnlock = async (enabled: boolean): Promise<void> => {
    setWriteUnlockBusy(true);
    try {
      await api.put('/api/admin/settings/write-unlock', { enabled });
      await refreshSettings();
      toast(
        enabled
          ? 'Write unlocking enabled for every account.'
          : 'Write unlocking disabled — the app is read-only for everybody.',
        enabled ? 'success' : 'warn',
      );
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setWriteUnlockBusy(false);
    }
  };

  const deleteConnection = async (): Promise<void> => {
    if (!deletingConnection) return;
    const target = deletingConnection;
    const wasActive = target.id === activeProfileId;
    setBusy(target.id);
    try {
      await api.del(`/api/connections/${target.id}`);
      // Drop the live session before refreshing so a failed refresh cannot leave a dead profile active.
      if (wasActive) await disconnect();
      setDeletingConnection(null);
      toast(`Deleted ${target.name}.`, 'success');
      try {
        await refreshProfiles();
      } catch (error) {
        toast(
          `The connection list could not be refreshed: ${error instanceof Error ? error.message : String(error)}`,
          'warn',
        );
      }
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setBusy(null);
    }
  };

  const testConnection = async (profile: ConnectionProfile): Promise<void> => {
    setBusy(profile.id);
    try {
      const result = await api.post<{
        ok: boolean;
        latencyMs: number;
        server?: { version: string };
        error?: string;
      }>('/api/connections/test', {
        name: profile.name,
        host: profile.host,
        port: profile.port,
        user: profile.user,
        database: profile.database ?? undefined,
        socketPath: profile.socketPath ?? undefined,
        ssl: profile.ssl ?? undefined,
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
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setBusy(null);
    }
  };

  const testProvider = async (provider: AiProvider): Promise<void> => {
    setTestingProvider(provider.id);
    try {
      const result = await api.post<AiProviderTestResult>(`/api/ai/providers/${provider.id}/test`);
      if (result.ok) {
        toast(`${result.message}${result.latencyMs ? ` (${result.latencyMs} ms)` : ''}`, 'success');
        await refreshProviders();
      } else {
        toast(result.message, 'error');
      }
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setTestingProvider(null);
    }
  };

  const makeDefaultProvider = async (provider: AiProvider): Promise<void> => {
    setBusy(provider.id);
    try {
      await api.post(`/api/ai/providers/${provider.id}/default`);
      await Promise.all([refreshProviders(), refreshSettings()]);
      toast(`${provider.name} is now the default provider.`, 'success');
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setBusy(null);
    }
  };

  const deleteProvider = async (): Promise<void> => {
    if (!deletingProvider) return;
    setBusy(deletingProvider.id);
    try {
      await api.del(`/api/ai/providers/${deletingProvider.id}`);
      await refreshProviders();
      toast(`Deleted ${deletingProvider.name}.`, 'success');
      setDeletingProvider(null);
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setBusy(null);
    }
  };

  const clearHistory = async (): Promise<void> => {
    if (!activeProfileId) {
      setConfirmClearHistory(false);
      toast('Connect to a database before clearing query history.', 'warn');
      return;
    }
    setClearingHistory(true);
    try {
      await api.del(`/api/history?profileId=${encodeURIComponent(activeProfileId)}`);
      toast('Query history cleared for the active connection.', 'success');
      setConfirmClearHistory(false);
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setClearingHistory(false);
    }
  };

  const activeProfileName =
    profiles.find((profile) => profile.id === activeProfileId)?.name ?? null;

  return (
    <div className="page">
      <SettingsHeader
        tab={tab}
        profileCount={profiles.length}
        providerCount={providers.length}
        onTabChange={setTab}
      />

      {tab === 'connections' ? (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="section-title">Connections</div>
            <Button
              variant="primary"
              size="sm"
              className="ml-auto"
              icon={<Plus size={13} />}
              onClick={() => setConnectionModal({ open: true, profile: null })}
            >
              Add connection
            </Button>
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {profiles.map((profile) => (
              <Card key={profile.id} className="p-4">
                <div className="flex items-start gap-3">
                  <div
                    className="mt-1 h-8 w-1 rounded-full"
                    style={{ background: profile.color ?? '#ff8a3d' }}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-sm font-bold">{profile.name}</span>
                      {profile.id === activeProfileId ? <Badge tone="mint">active</Badge> : null}
                      {profile.writeAccess === 'locked' ? (
                        <Badge tone="warn">read-only for members</Badge>
                      ) : null}
                    </div>
                    <div className="mt-1 font-mono text-2xs text-muted">
                      {profile.user}@{profile.host}:{profile.port}
                      {profile.database ? ` / ${profile.database}` : ''}
                    </div>
                    <div className="mt-2 text-2xs text-muted">
                      {profile.ssl?.enabled ? 'TLS · ' : ''}
                      {profile.passwordSource === 'saved'
                        ? 'encrypted password'
                        : profile.passwordSource === 'session'
                          ? 'session password'
                          : 'no saved password'}
                      {' · '}
                      {profile.lastUsedAt
                        ? `used ${formatRelative(profile.lastUsedAt)}`
                        : 'never used'}
                      {' · '}
                      {profile.databaseScope === 'selected'
                        ? `${profile.allowedDatabases.length} DB scope`
                        : 'all databases'}
                    </div>
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap gap-1 border-t border-line-soft pt-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    icon={busy === profile.id ? <Spinner size={11} /> : <Zap size={11} />}
                    onClick={() => void testConnection(profile)}
                    disabled={Boolean(busy)}
                  >
                    Test
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={<Edit3 size={11} />}
                    onClick={() => setConnectionModal({ open: true, profile })}
                  >
                    Edit
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="ml-auto text-danger"
                    icon={<Trash2 size={11} />}
                    onClick={() => setDeletingConnection(profile)}
                  >
                    Delete
                  </Button>
                </div>
              </Card>
            ))}
          </div>
        </div>
      ) : null}

      {tab === 'ai' ? (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="section-title">AI providers</div>
            <Button
              variant="primary"
              size="sm"
              icon={<Plus size={13} />}
              onClick={() => setProviderModal({ open: true, provider: null })}
            >
              Add provider
            </Button>
          </div>
          {providers.length === 0 ? (
            <Card className="p-6">
              <div className="flex flex-col items-center gap-2 text-center">
                <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-line bg-panel-3 text-ember">
                  <Sparkles size={22} />
                </div>
                <div className="text-base font-bold">No AI provider configured</div>
                <div className="max-w-md text-xs text-muted">
                  Reviews work without AI; add a provider for AI feedback.
                </div>
                <Button
                  variant="primary"
                  icon={<Plus size={13} />}
                  onClick={() => setProviderModal({ open: true, provider: null })}
                >
                  Add provider
                </Button>
              </div>
            </Card>
          ) : (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              {providers.map((provider) => (
                <Card key={provider.id} className="p-4">
                  <div className="flex items-start gap-2">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-line bg-panel-3 text-ember">
                      <Sparkles size={16} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="truncate text-sm font-bold">{provider.name}</span>
                        {provider.isDefault ? (
                          <Badge tone="ember">
                            <Star size={9} /> default
                          </Badge>
                        ) : null}
                        <span className="font-mono text-2xs text-muted">{provider.type}</span>
                      </div>
                      <div className="mt-1 truncate font-mono text-2xs text-muted">
                        {provider.baseUrl} · {provider.model}
                      </div>
                      <div className="mt-2 font-mono text-2xs text-muted">
                        {provider.hasApiKey ? provider.apiKeyHint : 'no key'}
                      </div>
                    </div>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-1 border-t border-line-soft pt-2">
                    <Button
                      variant="secondary"
                      size="sm"
                      icon={
                        testingProvider === provider.id ? <Spinner size={11} /> : <Zap size={11} />
                      }
                      onClick={() => void testProvider(provider)}
                      disabled={Boolean(testingProvider)}
                    >
                      Test
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      icon={<Edit3 size={11} />}
                      onClick={() => setProviderModal({ open: true, provider })}
                    >
                      Edit
                    </Button>
                    {!provider.isDefault ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        icon={<Star size={11} />}
                        onClick={() => void makeDefaultProvider(provider)}
                        disabled={Boolean(busy)}
                      >
                        Make default
                      </Button>
                    ) : null}
                    <Button
                      variant="ghost"
                      size="sm"
                      className="ml-auto text-danger"
                      icon={<Trash2 size={11} />}
                      onClick={() => setDeletingProvider(provider)}
                    >
                      Delete
                    </Button>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </div>
      ) : null}

      {tab === 'review' ? (
        <Card className="p-4">
          <div className="section-title mb-3">Review behavior</div>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div className="flex items-start justify-between gap-4 rounded-xl border border-line-soft bg-panel-2 p-3">
              <div>
                <div className="text-xs font-semibold">Live lint</div>
                <div className="mt-0.5 text-2xs text-muted">
                  Adds at most one review request per typing pause.
                </div>
              </div>
              <Switch
                label="Live lint"
                checked={draft.liveLint}
                onChange={(value) => setDraft((current) => ({ ...current, liveLint: value }))}
              />
            </div>
            <div className="flex items-start justify-between gap-4 rounded-xl border border-line-soft bg-panel-2 p-3">
              <div>
                <div className="text-xs font-semibold">Include schema by default</div>
                <div className="mt-0.5 text-2xs text-muted">
                  Sends table and index context with reviews.
                </div>
              </div>
              <Switch
                label="Include schema by default"
                checked={draft.includeSchemaByDefault}
                onChange={(value) =>
                  setDraft((current) => ({ ...current, includeSchemaByDefault: value }))
                }
              />
            </div>
            <Field label="AI context budget (characters)" error={numericErrors.aiContextChars}>
              <Input
                type="number"
                inputMode="numeric"
                value={numericDrafts.aiContextChars}
                onChange={(event) => updateNumeric('aiContextChars', event.target.value)}
                onBlur={() => blurNumeric('aiContextChars')}
                aria-invalid={Boolean(numericErrors.aiContextChars)}
              />
            </Field>
            <Field label="Default AI provider">
              <Combobox
                options={[
                  { value: '', label: '(first available)' },
                  ...providers.map((provider) => ({
                    value: provider.id,
                    label: provider.name,
                    description: provider.model,
                  })),
                ]}
                value={draft.defaultAiProviderId ?? ''}
                onChange={(value) =>
                  setDraft((current) => ({
                    ...current,
                    defaultAiProviderId: value || null,
                  }))
                }
                clearable={false}
              />
            </Field>
          </div>
          <div className="mt-3 flex justify-end">
            <Button variant="primary" loading={savingSettings} onClick={() => void saveSettings()}>
              Save review settings
            </Button>
          </div>
        </Card>
      ) : null}

      {tab === 'safety' ? (
        <SafetyTab
          writeUnlockEnabled={writeUnlockEnabled}
          writeUnlockBusy={writeUnlockBusy}
          savingSettings={savingSettings}
          draft={draft}
          numericDrafts={numericDrafts}
          numericErrors={numericErrors}
          onToggleWriteUnlock={(value) => void toggleWriteUnlock(value)}
          onToggleMaskSensitive={(value) =>
            setDraft((current) => ({ ...current, maskSensitiveColumns: value }))
          }
          onToggleAgentTool={(name) =>
            setDraft((current) => {
              const disabled = new Set(current.disabledAgentTools ?? []);
              if (disabled.has(name)) disabled.delete(name);
              else disabled.add(name);
              return { ...current, disabledAgentTools: [...disabled] };
            })
          }
          mcpServersJson={mcpServersJson}
          mcpError={mcpError}
          onMcpServersChange={setMcpServersJson}
          onMcpServersApply={() => {
            const text = mcpServersJson.trim();
            if (!text) {
              setMcpError(null);
              setDraft((current) => ({ ...current, mcpServers: [] }));
              return;
            }
            try {
              const parsed = JSON.parse(text) as unknown;
              if (!Array.isArray(parsed)) throw new Error('MCP servers must be a JSON array.');
              for (const server of parsed) {
                if (!server || typeof server !== 'object') {
                  throw new Error('Every MCP server must be an object.');
                }
                const entry = server as Record<string, unknown>;
                if (typeof entry.name !== 'string' || !/^[a-z0-9_-]+$/.test(entry.name)) {
                  throw new Error('Every MCP server needs a slug "name" (a-z, 0-9, -, _).');
                }
                if (typeof entry.command !== 'string' || !entry.command.trim()) {
                  throw new Error(`MCP server "${entry.name}" needs a "command".`);
                }
              }
              setMcpError(null);
              setDraft((current) => ({
                ...current,
                mcpServers: parsed as AppSettings['mcpServers'],
              }));
            } catch (cause) {
              setMcpError(cause instanceof Error ? cause.message : String(cause));
            }
          }}
          onNumericChange={updateNumeric}
          onNumericBlur={blurNumeric}
          onSave={() => void saveSettings()}
        />
      ) : null}

      {tab === 'appearance' ? (
        <Card className="p-4">
          <div className="section-title mb-3">Theme</div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            {(
              [
                { id: 'dark', label: 'Obsidian' },
                { id: 'light', label: 'Paper' },
                { id: 'system', label: 'System' },
              ] as { id: ThemePreference; label: string }[]
            ).map((option) => (
              <button
                key={option.id}
                type="button"
                className={cn(
                  'rounded-xl border p-3 text-left transition',
                  theme === option.id
                    ? 'border-ember/50 bg-ember/5'
                    : 'border-line-soft bg-panel-2 hover:border-line',
                )}
                onClick={() => void setTheme(option.id)}
              >
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold">{option.label}</span>
                  {theme === option.id ? (
                    <CheckCircle2 size={13} className="ml-auto text-ember" />
                  ) : null}
                </div>
              </button>
            ))}
          </div>
        </Card>
      ) : null}

      {tab === 'data' ? (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <Card className="p-4">
            <div className="section-title mb-3">Local data</div>
            <div className="flex flex-col gap-2 text-2xs">
              {[
                ['Data directory', boot?.dataDir ?? '—'],
                ['Connections', String(profiles.length)],
                ['AI providers', String(providers.length)],
                ['Saved reports', String(reports.length)],
                ['Node runtime', boot?.nodeVersion ?? '—'],
              ].map(([label, value]) => (
                <div
                  key={label}
                  className="flex items-start justify-between gap-3 border-b border-line-soft py-1.5"
                >
                  <span className="text-muted">{label}</span>
                  <span className="max-w-[65%] break-all text-right font-mono text-2xs">
                    {value}
                  </span>
                </div>
              ))}
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                variant="danger"
                size="sm"
                icon={<Trash2 size={11} />}
                onClick={() => {
                  if (!activeProfileId) {
                    toast(
                      'Connect to a database first — history is cleared per connection.',
                      'warn',
                    );
                    return;
                  }
                  setConfirmClearHistory(true);
                }}
              >
                Clear query history
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setTab('connections')}>
                Manage connections
              </Button>
            </div>
          </Card>

          <Card className="p-4">
            <div className="section-title mb-3">Environment</div>
            <div className="flex flex-col gap-2 text-2xs">
              <div className="flex justify-between gap-2 border-b border-line-soft py-1.5">
                <span className="text-muted">XAMPP detected</span>
                <span className="font-mono text-2xs">{detectedXampp?.path ?? 'not detected'}</span>
              </div>
              <div className="flex justify-between gap-2 border-b border-line-soft py-1.5">
                <span className="text-muted">MySQL port</span>
                <span className="font-mono text-2xs">{detectedXampp?.port ?? 3306}</span>
              </div>
              <div className="flex justify-between gap-2 border-b border-line-soft py-1.5">
                <span className="text-muted">App version</span>
                <span className="font-mono text-2xs">{boot?.version ?? '—'}</span>
              </div>
              <div className="flex justify-between gap-2 border-b border-line-soft py-1.5">
                <span className="text-muted">Platform</span>
                <span className="font-mono text-2xs">{boot?.platform ?? '—'}</span>
              </div>
            </div>
            <div className="mt-3 rounded-xl border border-line-soft bg-panel-2 p-3 text-2xs leading-5 text-muted">
              <div className="mb-1 flex items-center gap-1.5 font-semibold text-ink-soft">
                <Laptop size={12} /> Local-first by design
              </div>
              The API binds to 127.0.0.1 and requires a per-boot token. Database passwords and AI
              keys are encrypted with a local AES-256-GCM key. No telemetry is sent. Cloud AI is
              only contacted when you explicitly run a review or chat.
            </div>
          </Card>
        </div>
      ) : null}

      <Modal
        open={connectionModal.open}
        onClose={() => setConnectionModal({ open: false, profile: null })}
        title={connectionModal.profile ? 'Edit connection' : 'New connection'}
        subtitle={
          connectionModal.profile
            ? connectionModal.profile.name
            : `Works with XAMPP (${compatLine}).`
        }
        size="wide"
      >
        <ConnectionForm
          profile={connectionModal.profile}
          onCancel={() => setConnectionModal({ open: false, profile: null })}
          onSaved={async (profile) => {
            setConnectionModal({ open: false, profile: null });
            await refreshProfiles();
            toast(`Saved ${profile.name}.`, 'success');
          }}
        />
      </Modal>

      <Modal
        open={providerModal.open}
        onClose={() => setProviderModal({ open: false, provider: null })}
        title={providerModal.provider ? 'Edit AI provider' : 'New AI provider'}
        subtitle="OpenAI-compatible, Anthropic, or Google Gemini. Keys stay encrypted on this machine."
        size="wide"
      >
        <ProviderForm
          provider={providerModal.provider}
          onCancel={() => setProviderModal({ open: false, provider: null })}
          onSaved={async (provider) => {
            setProviderModal({ open: false, provider: null });
            await refreshProviders();
            toast(`Saved ${provider.name}.`, 'success');
          }}
        />
      </Modal>

      <ConfirmDialog
        open={confirmClearHistory}
        onClose={() => setConfirmClearHistory(false)}
        onConfirm={() => void clearHistory()}
        title="Clear query history?"
        message={
          activeProfileName
            ? `Delete the saved query history for “${activeProfileName}”. Reports and snippets are kept.`
            : 'Delete the saved query history for the active connection. Reports and snippets are kept.'
        }
        confirmLabel="Clear history"
        danger
        loading={clearingHistory}
      />

      <ConfirmDialog
        open={Boolean(deletingConnection)}
        onClose={() => setDeletingConnection(null)}
        onConfirm={() => void deleteConnection()}
        title={deleteConnectionTitle}
        message={deletingConnection ? deleteConnectionMessage(deletingConnection.name) : ''}
        confirmLabel={deleteConnectionConfirmLabel}
        danger
        loading={Boolean(busy)}
      />

      <ConfirmDialog
        open={Boolean(deletingProvider)}
        onClose={() => setDeletingProvider(null)}
        onConfirm={() => void deleteProvider()}
        title="Delete AI provider?"
        message={
          deletingProvider
            ? `Remove “${deletingProvider.name}” and its encrypted API key. This cannot be undone.`
            : ''
        }
        confirmLabel="Delete provider"
        danger
        loading={Boolean(busy)}
      />

      <div className="flex items-center justify-between text-2xs text-muted">
        <span>MyLens · local MySQL Review Studio</span>
        <span className="font-mono">v{boot?.version ?? APP_VERSION}</span>
      </div>
    </div>
  );
}
