import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Brain,
  CheckCircle2,
  Database,
  Edit3,
  KeyRound,
  Laptop,
  Plus,
  RefreshCw,
  Server,
  ShieldCheck,
  Sparkles,
  Star,
  Sun,
  Trash2,
  XCircle,
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
import { useAppStore } from '@/store/app-store';
import { api } from '@/lib/api';
import { formatRelative } from '@/lib/format';
import { ConnectionForm } from '@/components/ConnectionForm';
import { ProviderForm } from '@/components/ProviderForm';
import {
  Badge,
  Button,
  Card,
  Checkbox,
  ConfirmDialog,
  Field,
  Input,
  Modal,
  PageHeader,
  Spinner,
  Switch,
  Tabs,
  cn,
} from '@/components/ui';
import { Combobox } from '@/components/Combobox';

type SettingsTab = 'connections' | 'ai' | 'review' | 'safety' | 'appearance' | 'data';

const TAB_IDS: SettingsTab[] = ['connections', 'ai', 'review', 'safety', 'appearance', 'data'];

function parseTab(value: string | null): SettingsTab {
  return TAB_IDS.includes(value as SettingsTab) ? (value as SettingsTab) : 'connections';
}

export function SettingsPage() {
  const [params, setParams] = useSearchParams();
  const tab = parseTab(params.get('tab'));

  const profiles = useAppStore((state) => state.profiles);
  const providers = useAppStore((state) => state.providers);
  const settings = useAppStore((state) => state.settings);
  const theme = useAppStore((state) => state.theme);
  const activeProfileId = useAppStore((state) => state.activeProfileId);
  const boot = useAppStore((state) => state.boot);
  const detectedXampp = useAppStore((state) => state.detectedXampp);
  const refreshProfiles = useAppStore((state) => state.refreshProfiles);
  const refreshProviders = useAppStore((state) => state.refreshProviders);
  const updateSettings = useAppStore((state) => state.updateSettings);
  const setTheme = useAppStore((state) => state.setTheme);
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
  const [savingSettings, setSavingSettings] = useState(false);

  useEffect(() => {
    setDraft(settings);
  }, [settings]);

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

  const saveSettings = async (): Promise<void> => {
    setSavingSettings(true);
    try {
      await updateSettings(draft);
      toast('Settings saved.', 'success');
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setSavingSettings(false);
    }
  };

  const deleteConnection = async (): Promise<void> => {
    if (!deletingConnection) return;
    setBusy(deletingConnection.id);
    try {
      await api.del(`/api/connections/${deletingConnection.id}`);
      await refreshProfiles();
      toast(`Deleted ${deletingConnection.name}.`, 'success');
      setDeletingConnection(null);
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setBusy(null);
    }
  };

  const testConnection = async (profile: ConnectionProfile): Promise<void> => {
    setBusy(profile.id);
    try {
      const result = await api.post<{ ok: boolean; latencyMs: number; server?: { version: string }; error?: string }>(
        '/api/connections/test',
        {
          name: profile.name,
          host: profile.host,
          port: profile.port,
          user: profile.user,
          database: profile.database ?? undefined,
          socketPath: profile.socketPath ?? undefined,
          ssl: profile.ssl ?? undefined,
          profileId: profile.id,
        },
      );
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
      const result = await api.post<AiProviderTestResult>(
        `/api/ai/providers/${provider.id}/test`,
      );
      if (result.ok) {
        toast(
          `${result.message}${result.latencyMs ? ` (${result.latencyMs} ms)` : ''}`,
          'success',
        );
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
      await refreshProviders();
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
    try {
      await api.del(
        `/api/history?profileId=${encodeURIComponent(activeProfileId ?? '')}`,
      );
      toast('Query history cleared for the active connection.', 'success');
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error');
    }
  };

  return (
    <div className="page">
      <PageHeader
        title="Settings"
        subtitle="Connections, AI providers, review behavior, safety limits, appearance, and local data."
      />

      <Tabs
        items={[
          { id: 'connections', label: 'Connections', count: profiles.length, icon: <Database size={12} /> },
          { id: 'ai', label: 'AI providers', count: providers.length, icon: <Sparkles size={12} /> },
          { id: 'review', label: 'Review', icon: <Brain size={12} /> },
          { id: 'safety', label: 'Safety', icon: <ShieldCheck size={12} /> },
          { id: 'appearance', label: 'Appearance', icon: <Sun size={12} /> },
          { id: 'data', label: 'Data & about', icon: <Server size={12} /> },
        ]}
        value={tab}
        onChange={setTab}
      />

      {tab === 'connections' ? (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="section-title">Connection profiles</div>
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
                      <span className="truncate text-[13px] font-bold">{profile.name}</span>
                      {profile.id === activeProfileId ? <Badge tone="mint">active</Badge> : null}
                      {profile.ssl?.enabled ? <Badge tone="mint">TLS</Badge> : null}
                    </div>
                    <div className="mt-1 font-mono text-[10.5px] text-muted">
                      {profile.user}@{profile.host}:{profile.port}
                      {profile.database ? ` / ${profile.database}` : ''}
                    </div>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      <Badge tone={profile.passwordSource === 'saved' ? 'mint' : 'warn'}>
                        <KeyRound size={9} />
                        {profile.passwordSource === 'saved'
                          ? 'encrypted password'
                          : profile.passwordSource === 'session'
                            ? 'session password'
                            : 'no saved password'}
                      </Badge>
                      <Badge tone="neutral">
                        {profile.lastUsedAt
                          ? `used ${formatRelative(profile.lastUsedAt)}`
                          : 'never used'}
                      </Badge>
                      <Badge tone={profile.databaseScope === 'selected' ? 'ember' : 'neutral'}>
                        {profile.databaseScope === 'selected'
                          ? `${profile.allowedDatabases.length} DB scope`
                          : 'all databases'}
                      </Badge>
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
            <Badge tone="neutral" className="ml-auto">
              keys encrypted at rest
            </Badge>
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
                <div className="text-[14px] font-bold">No AI provider configured</div>
                <div className="max-w-md text-[12px] text-muted">
                  Add OpenAI, OpenRouter, DeepSeek, Groq, Anthropic, Gemini, Ollama, LM Studio, or
                  any custom OpenAI-compatible endpoint. Deterministic reviews work without AI.
                </div>
                <Button
                  variant="primary"
                  icon={<Plus size={13} />}
                  onClick={() => setProviderModal({ open: true, provider: null })}
                >
                  Add your first provider
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
                        <span className="truncate text-[13px] font-bold">{provider.name}</span>
                        {provider.isDefault ? (
                          <Badge tone="ember">
                            <Star size={9} /> default
                          </Badge>
                        ) : null}
                        <Badge tone="neutral">{provider.type}</Badge>
                      </div>
                      <div className="mt-1 truncate font-mono text-[10px] text-muted">
                        {provider.baseUrl} · {provider.model}
                      </div>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        <Badge tone={provider.hasApiKey ? 'mint' : 'warn'}>
                          <KeyRound size={9} />
                          {provider.hasApiKey ? provider.apiKeyHint : 'no key'}
                        </Badge>
                        <Badge tone="neutral">
                          {provider.streaming ? 'streaming' : 'non-streaming'}
                        </Badge>
                        <Badge tone="neutral">{provider.maxTokens} max tokens</Badge>
                      </div>
                    </div>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-1 border-t border-line-soft pt-2">
                    <Button
                      variant="secondary"
                      size="sm"
                      icon={
                        testingProvider === provider.id ? (
                          <Spinner size={11} />
                        ) : (
                          <Zap size={11} />
                        )
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
            <div className="flex items-start justify-between gap-4 rounded-xl border border-line-soft bg-panel-2/40 p-3">
              <div>
                <div className="text-[12px] font-semibold">Live lint</div>
                <div className="mt-0.5 text-[10.5px] text-muted">
                  Run static rules while you type. Adds at most one review request per pause.
                </div>
              </div>
              <Switch
                checked={draft.liveLint}
                onChange={(value) => setDraft((current) => ({ ...current, liveLint: value }))}
              />
            </div>
            <div className="flex items-start justify-between gap-4 rounded-xl border border-line-soft bg-panel-2/40 p-3">
              <div>
                <div className="text-[12px] font-semibold">Include schema by default</div>
                <div className="mt-0.5 text-[10.5px] text-muted">
                  Give the reviewer table, column, index, and foreign-key context.
                </div>
              </div>
              <Switch
                checked={draft.includeSchemaByDefault}
                onChange={(value) =>
                  setDraft((current) => ({ ...current, includeSchemaByDefault: value }))
                }
              />
            </div>
            <Field
              label="AI context budget (characters)"
              hint="Schema and plan text are truncated to this budget before sending."
            >
              <Input
                type="number"
                value={draft.aiContextChars}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    aiContextChars: Number(event.target.value),
                  }))
                }
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
            <Button
              variant="primary"
              loading={savingSettings}
              onClick={() => void saveSettings()}
            >
              Save review settings
            </Button>
          </div>
        </Card>
      ) : null}

      {tab === 'safety' ? (
        <div className="flex flex-col gap-3">
          <Card className="p-4">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <ShieldCheck size={15} className="text-mint" />
              <div className="section-title">Read-only by default</div>
              <Badge tone="mint" className="ml-auto">
                always enforced by the server
              </Badge>
            </div>
            <div className="callout mint text-[11.5px]">
              SELECT, SHOW, DESCRIBE, and EXPLAIN run freely. DML, DDL, and administrative
              statements require typing <span className="font-mono">UNLOCK WRITES</span> for a
              15-minute per-connection window. Destructive statements add a second confirmation.
              This cannot be disabled in the UI.
            </div>
          </Card>
          <Card className="p-4">
            <div className="section-title mb-3">Sensitive data</div>
            <div className="flex items-start justify-between gap-4 rounded-xl border border-line-soft bg-panel-2/40 p-3">
              <div>
                <div className="text-[12px] font-semibold">Mask sensitive columns</div>
                <div className="mt-0.5 max-w-xl text-[10.5px] leading-4 text-muted">
                  Credential-like columns (password, token, secret, API key, private key,
                  session id, card number, SSN) are masked before results reach the
                  browser. You can reveal them per query after a confirmation. This is a
                  safety net, not a substitute for database grants.
                </div>
              </div>
              <Switch
                checked={draft.maskSensitiveColumns}
                onChange={(value) =>
                  setDraft((current) => ({ ...current, maskSensitiveColumns: value }))
                }
              />
            </div>
            <div className="mt-3 flex justify-end">
              <Button
                variant="primary"
                loading={savingSettings}
                onClick={() => void saveSettings()}
              >
                Save masking setting
              </Button>
            </div>
          </Card>
          <Card className="p-4">
            <div className="section-title mb-3">Query limits</div>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <Field
                label="Row cap"
                hint="Applied as sql_select_limit for interactive queries. 1–10,000."
              >
                <Input
                  type="number"
                  value={draft.rowLimit}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, rowLimit: Number(event.target.value) }))
                  }
                />
              </Field>
              <Field
                label="Query timeout (ms)"
                hint="Server-side max_statement_time / max_execution_time, plus client timeout."
              >
                <Input
                  type="number"
                  value={draft.queryTimeoutMs}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      queryTimeoutMs: Number(event.target.value),
                    }))
                  }
                />
              </Field>
              <Field
                label="Cell size cap (characters)"
                hint="Long text and binary values are truncated in the result grid."
              >
                <Input
                  type="number"
                  value={draft.cellMaxChars}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      cellMaxChars: Number(event.target.value),
                    }))
                  }
                />
              </Field>
              <Field label="History entries" hint="Server-side query history cap. 50–5,000.">
                <Input
                  type="number"
                  value={draft.historyLimit}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      historyLimit: Number(event.target.value),
                    }))
                  }
                />
              </Field>
            </div>
            <div className="mt-3 flex justify-end">
              <Button
                variant="primary"
                loading={savingSettings}
                onClick={() => void saveSettings()}
              >
                Save safety settings
              </Button>
            </div>
          </Card>
        </div>
      ) : null}

      {tab === 'appearance' ? (
        <Card className="p-4">
          <div className="section-title mb-3">Theme</div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            {(
              [
                { id: 'dark', label: 'Obsidian', copy: 'Deep charcoal with ember accents.' },
                { id: 'light', label: 'Paper', copy: 'Warm light theme for daylight.' },
                { id: 'system', label: 'System', copy: 'Follow the OS preference.' },
              ] as { id: ThemePreference; label: string; copy: string }[]
            ).map((option) => (
              <button
                key={option.id}
                type="button"
                className={cn(
                  'rounded-xl border p-3 text-left transition',
                  theme === option.id
                    ? 'border-ember/50 bg-ember/5'
                    : 'border-line-soft bg-panel-2/40 hover:border-line',
                )}
                onClick={() => void setTheme(option.id)}
              >
                <div className="flex items-center gap-2">
                  <span className="text-[12px] font-semibold">{option.label}</span>
                  {theme === option.id ? (
                    <CheckCircle2 size={13} className="ml-auto text-ember" />
                  ) : null}
                </div>
                <div className="mt-1 text-[10.5px] text-muted">{option.copy}</div>
              </button>
            ))}
          </div>
          <div className="mt-3 text-[10.5px] text-muted">
            The theme is stored in your MyLens settings on this machine.
          </div>
        </Card>
      ) : null}

      {tab === 'data' ? (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <Card className="p-4">
            <div className="section-title mb-3">Local data</div>
            <div className="flex flex-col gap-2 text-[11.5px]">
              {[
                ['Data directory', boot?.dataDir ?? '—'],
                ['Connection profiles', String(profiles.length)],
                ['AI providers', String(providers.length)],
                ['Saved reports', String(reports.length)],
                ['Node runtime', boot?.nodeVersion ?? '—'],
              ].map(([label, value]) => (
                <div key={label} className="flex items-start justify-between gap-3 border-b border-line-soft py-1.5">
                  <span className="text-muted">{label}</span>
                  <span className="max-w-[65%] break-all text-right font-mono text-[10px]">{value}</span>
                </div>
              ))}
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                variant="danger"
                size="sm"
                icon={<Trash2 size={11} />}
                onClick={() => void clearHistory()}
              >
                Clear query history
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setTab('connections')}
              >
                Manage connections
              </Button>
            </div>
            <div className="mt-2 text-[10px] leading-4 text-muted">
              Reports and snippets are not deleted by clearing history. Delete reports from the
              Reports page.
            </div>
          </Card>

          <Card className="p-4">
            <div className="section-title mb-3">Environment</div>
            <div className="flex flex-col gap-2 text-[11.5px]">
              <div className="flex justify-between gap-2 border-b border-line-soft py-1.5">
                <span className="text-muted">XAMPP detected</span>
                <span className="font-mono text-[10px]">{detectedXampp?.path ?? 'not detected'}</span>
              </div>
              <div className="flex justify-between gap-2 border-b border-line-soft py-1.5">
                <span className="text-muted">MySQL port</span>
                <span className="font-mono text-[10px]">{detectedXampp?.port ?? 3306}</span>
              </div>
              <div className="flex justify-between gap-2 border-b border-line-soft py-1.5">
                <span className="text-muted">App version</span>
                <span className="font-mono text-[10px]">{boot?.version ?? '—'}</span>
              </div>
              <div className="flex justify-between gap-2 border-b border-line-soft py-1.5">
                <span className="text-muted">Platform</span>
                <span className="font-mono text-[10px]">{boot?.platform ?? '—'}</span>
              </div>
            </div>
            <div className="mt-3 rounded-xl border border-line-soft bg-panel-2/40 p-3 text-[10.5px] leading-5 text-muted">
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
            : 'Works with XAMPP, MySQL 5.7/8.x, and MariaDB 10.x.'
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
        open={Boolean(deletingConnection)}
        onClose={() => setDeletingConnection(null)}
        onConfirm={() => void deleteConnection()}
        title="Delete connection?"
        message={
          deletingConnection
            ? `Remove “${deletingConnection.name}” from MyLens. The MySQL server and its data are untouched.`
            : ''
        }
        confirmLabel="Delete connection"
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

      <div className="flex items-center justify-between text-[10px] text-muted">
        <span>MyLens · local MySQL Review Studio</span>
        <span className="font-mono">v{boot?.version ?? '1.0.0'}</span>
      </div>
    </div>
  );
}
