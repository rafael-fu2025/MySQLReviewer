import { useState } from 'react';
import { CheckCircle2, Sparkles, XCircle } from 'lucide-react';
import type { AiProvider, AiProviderInput, AiProviderPreset } from '@shared/types';
import { AI_PROVIDER_PRESETS } from '@shared/types';
import { api, ApiError } from '@/lib/api';
import { Button, Checkbox, Field, Input, Switch, Textarea } from './ui';
import { cn } from '@/lib/utils';
import { Combobox, TextCombobox } from './Combobox';

interface FormState {
  name: string;
  type: 'openai' | 'anthropic' | 'google';
  baseUrl: string;
  chatPath: string;
  modelsPath: string;
  model: string;
  apiKey: string;
  clearApiKey: boolean;
  authHeader: string;
  authPrefix: string;
  headersJson: string;
  extraBodyJson: string;
  temperature: string;
  maxTokens: string;
  streaming: boolean;
  thinkingEnabled: boolean;
  isDefault: boolean;
}

function initialState(provider?: AiProvider | null): FormState {
  return {
    name: provider?.name ?? '',
    type: provider?.type ?? 'openai',
    baseUrl: provider?.baseUrl ?? 'https://api.openai.com/v1',
    chatPath: provider?.chatPath ?? '/chat/completions',
    modelsPath: provider?.modelsPath ?? '/models',
    model: provider?.model ?? '',
    apiKey: '',
    clearApiKey: false,
    authHeader: provider?.authHeader ?? 'Authorization',
    authPrefix: provider?.authPrefix ?? 'Bearer ',
    headersJson: provider ? JSON.stringify(provider.headers, null, 2) : '{}',
    extraBodyJson: provider ? JSON.stringify(provider.extraBody, null, 2) : '{}',
    temperature: String(provider?.temperature ?? 0.2),
    maxTokens: String(provider?.maxTokens ?? 4096),
    streaming: provider?.streaming ?? true,
    thinkingEnabled: provider?.thinkingEnabled ?? false,
    isDefault: provider?.isDefault ?? false,
  };
}

function applyPreset(preset: AiProviderPreset, current: FormState): FormState {
  return {
    ...current,
    name: current.name || preset.label,
    type: preset.type,
    baseUrl: preset.baseUrl,
    chatPath: preset.chatPath,
    modelsPath: preset.modelsPath,
    model: preset.model || current.model,
    authHeader: preset.authHeader,
    authPrefix: preset.authPrefix,
    isDefault: current.isDefault || preset.id === 'openai',
  };
}

function parseObject(text: string, label: string): Record<string, unknown> {
  const trimmed = text.trim();
  if (!trimmed) return {};
  const parsed = JSON.parse(trimmed) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

export function ProviderForm({
  provider,
  onSaved,
  onCancel,
}: {
  provider?: AiProvider | null;
  onSaved: (provider: AiProvider) => void;
  onCancel?: () => void;
}) {
  const [form, setForm] = useState<FormState>(() => initialState(provider));
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    message: string;
    latencyMs: number;
    models: string[];
  } | null>(null);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]): void => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  const buildPayload = (): AiProviderInput => {
    const parsedHeaders = parseObject(form.headersJson, 'Headers');
    const headers: Record<string, string> = Object.fromEntries(
      Object.entries(parsedHeaders).map(([key, value]) => [key, String(value)]),
    );
    const extraBody = parseObject(form.extraBodyJson, 'Extra body');
    return {
      name: form.name.trim(),
      type: form.type,
      baseUrl: form.baseUrl.trim(),
      chatPath: form.chatPath.trim() || undefined,
      modelsPath: form.modelsPath.trim() || undefined,
      model: form.model.trim(),
      ...(form.apiKey ? { apiKey: form.apiKey } : {}),
      ...(form.clearApiKey ? { clearApiKey: true } : {}),
      authHeader: form.authHeader.trim(),
      authPrefix: form.authPrefix,
      headers,
      extraBody,
      temperature: Number(form.temperature),
      maxTokens: Number(form.maxTokens),
      streaming: form.streaming,
      thinkingEnabled: form.type === 'anthropic' ? form.thinkingEnabled : false,
      isDefault: form.isDefault,
    };
  };

  const save = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const payload = buildPayload();
      const saved = provider
        ? await api.put<AiProvider>(`/api/ai/providers/${provider.id}`, payload)
        : await api.post<AiProvider>('/api/ai/providers', payload);
      onSaved(saved);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const test = async (): Promise<void> => {
    if (!provider) {
      setTestResult({
        ok: false,
        message: 'Save the provider first, then run its connection test.',
        latencyMs: 0,
        models: [],
      });
      return;
    }
    setTesting(true);
    setTestResult(null);
    setError(null);
    try {
      const result = await api.post<{
        ok: boolean;
        message: string;
        latencyMs: number;
        models: string[];
      }>(`/api/ai/providers/${provider.id}/test`);
      setTestResult(result);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setTesting(false);
    }
  };

  return (
    <form className="flex flex-col gap-4" onSubmit={save}>
      <div>
        <div className="mono-label mb-2">Start from a preset</div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {AI_PROVIDER_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              className={cn(
                'rounded-lg border border-line bg-panel-2 p-2.5 text-left transition hover:border-ember/40',
                form.baseUrl === preset.baseUrl && 'border-ember/50 bg-ember/5',
              )}
              onClick={() => setForm((current) => applyPreset(preset, current))}
            >
              <div className="text-2xs font-semibold text-ink">{preset.label}</div>
              <div className="mt-0.5 line-clamp-2 text-2xs leading-4 text-muted">
                {preset.description}
              </div>
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Display name">
          <Input
            value={form.name}
            onChange={(event) => set('name', event.target.value)}
            placeholder="My provider"
            autoFocus
          />
        </Field>
        <Field label="API type" hint="Use OpenAI-compatible for any custom endpoint or proxy.">
          <Combobox
            options={[
              { value: 'openai', label: 'OpenAI-compatible' },
              { value: 'anthropic', label: 'Anthropic Messages' },
              { value: 'google', label: 'Google Gemini' },
            ]}
            value={form.type}
            onChange={(value) => set('type', value as FormState['type'])}
            clearable={false}
            maxHeight={240}
          />
        </Field>
        <Field label="Base URL" className="sm:col-span-2">
          <Input
            className="font-mono text-2xs"
            value={form.baseUrl}
            onChange={(event) => set('baseUrl', event.target.value)}
            placeholder="https://api.openai.com/v1"
          />
        </Field>
        <Field label="Model">
          <TextCombobox
            value={form.model}
            onChange={(value) => set('model', value)}
            placeholder="gpt-4.1-mini"
            inputClassName="font-mono text-2xs"
            emptyText="No matching models on file."
            ariaLabel="Model"
            options={(provider?.models ?? []).map((model) => ({ value: model, label: model }))}
          />
        </Field>
        <Field
          label="API key"
          hint={
            provider?.hasApiKey
              ? `Saved key: ${provider.apiKeyHint ?? '••••'}. Leave blank to keep it.`
              : undefined
          }
        >
          <Input
            className="font-mono text-2xs"
            type="password"
            value={form.apiKey}
            onChange={(event) => set('apiKey', event.target.value)}
            placeholder={provider?.hasApiKey ? '••••••••' : 'optional for local servers'}
          />
        </Field>
        {provider?.hasApiKey ? (
          <div className="sm:col-span-2">
            <Checkbox
              label="Clear the saved API key"
              checked={form.clearApiKey}
              onChange={(value) => set('clearApiKey', value)}
            />
          </div>
        ) : null}
        <Field label="Chat path">
          <Input
            className="font-mono text-2xs"
            value={form.chatPath}
            onChange={(event) => set('chatPath', event.target.value)}
            placeholder="/chat/completions"
          />
        </Field>
        <Field label="Models path">
          <Input
            className="font-mono text-2xs"
            value={form.modelsPath}
            onChange={(event) => set('modelsPath', event.target.value)}
            placeholder="/models"
          />
        </Field>
        <Field label="Auth header" hint="For OpenAI-compatible endpoints.">
          <Input
            className="font-mono text-2xs"
            value={form.authHeader}
            onChange={(event) => set('authHeader', event.target.value)}
            placeholder="Authorization"
          />
        </Field>
        <Field label="Auth prefix" hint="Usually “Bearer ” with a trailing space.">
          <Input
            className="font-mono text-2xs"
            value={form.authPrefix}
            onChange={(event) => set('authPrefix', event.target.value)}
            placeholder="Bearer "
          />
        </Field>
        <Field label="Temperature">
          <Input
            value={form.temperature}
            onChange={(event) => set('temperature', event.target.value)}
            inputMode="decimal"
          />
        </Field>
        <Field label="Max output tokens">
          <Input
            value={form.maxTokens}
            onChange={(event) => set('maxTokens', event.target.value)}
            inputMode="numeric"
          />
        </Field>
      </div>

      <details className="rounded-xl border border-line-soft bg-panel-2 p-3">
        <summary className="cursor-pointer text-2xs font-semibold text-muted">
          Advanced: custom headers and body
        </summary>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Headers (JSON)">
            <Textarea
              className="min-h-[90px] font-mono text-2xs"
              value={form.headersJson}
              onChange={(event) => set('headersJson', event.target.value)}
            />
          </Field>
          <Field label="Extra body (JSON)">
            <Textarea
              className="min-h-[90px] font-mono text-2xs"
              value={form.extraBodyJson}
              onChange={(event) => set('extraBodyJson', event.target.value)}
            />
          </Field>
        </div>
      </details>

      <div className="flex flex-wrap items-center gap-5">
        <div className="flex items-center gap-2 text-xs text-ink-soft">
          <Switch
            label="Stream responses"
            checked={form.streaming}
            onChange={(value) => set('streaming', value)}
          />
          <span>Stream responses</span>
        </div>
        {form.type === 'anthropic' ? (
          <div className="flex items-center gap-2 text-xs text-ink-soft">
            <Switch
              label="Extended thinking"
              checked={form.thinkingEnabled}
              onChange={(value) => set('thinkingEnabled', value)}
            />
            <span>Extended thinking</span>
          </div>
        ) : null}
        <Checkbox
          label="Use as the default provider"
          checked={form.isDefault}
          onChange={(value) => set('isDefault', value)}
        />
      </div>

      {error ? (
        <div className="callout danger flex items-start gap-2">
          <XCircle size={14} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}

      {testResult ? (
        <div className={cn('callout flex items-start gap-2', testResult.ok ? 'mint' : 'danger')}>
          {testResult.ok ? (
            <CheckCircle2 size={15} className="mt-0.5 shrink-0 text-mint" />
          ) : (
            <XCircle size={15} className="mt-0.5 shrink-0 text-danger" />
          )}
          <div className="flex flex-col gap-1">
            <span>{testResult.message}</span>
            {testResult.models.length > 0 ? (
              <span className="font-mono text-2xs text-muted">
                {testResult.models.slice(0, 8).join(', ')}
                {testResult.models.length > 8 ? '…' : ''}
              </span>
            ) : null}
          </div>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-end gap-2">
        {onCancel ? (
          <Button type="button" variant="tertiary" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
        <Button
          type="button"
          variant="secondary"
          icon={<Sparkles size={13} />}
          onClick={test}
          loading={testing}
        >
          Test
        </Button>
        <Button type="submit" variant="primary" loading={saving}>
          {provider ? 'Save provider' : 'Add provider'}
        </Button>
      </div>
    </form>
  );
}
