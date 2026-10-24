import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Database, KeyRound, Unlock } from 'lucide-react';
import type { CharsetInfo, ConnectionProfile, CreateDatabaseResult } from '@shared/types';
import { dbApi } from '@/lib/db-api';
import { notExecutedBadge } from '@/lib/copy';
import { useAppStore } from '@/store/app-store';
import { ApiError } from '@/lib/api';
import { UnlockDialog } from './UnlockDialog';
import { Combobox } from './Combobox';
import { Badge, Button, Checkbox, CopyButton, Field, Input, Modal, Spinner } from './ui';
import { cn } from '@/lib/utils';

const IDENTIFIER = /^[A-Za-z0-9_]{1,64}$/;

export function CreateDatabaseModal({
  open,
  onClose,
  profile,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  profile: ConnectionProfile;
  onCreated: (result: CreateDatabaseResult) => void;
}) {
  const unlockedUntil = useAppStore((state) => state.unlockedUntil);
  const toast = useAppStore((state) => state.toast);
  const [name, setName] = useState('');
  const [charsets, setCharsets] = useState<CharsetInfo[]>([]);
  const [charset, setCharset] = useState('utf8mb4');
  const [collation, setCollation] = useState('utf8mb4_general_ci');
  const [addToScope, setAddToScope] = useState(true);
  const [loadingCharsets, setLoadingCharsets] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CreateDatabaseResult | null>(null);
  const [unlockOpen, setUnlockOpen] = useState(false);

  // `unlockedUntil` is an absolute timestamp. The clock is read in an effect
  // so the flag flips exactly when the unlock window closes, instead of
  // reading the time while rendering.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!unlockedUntil) return;
    const remaining = unlockedUntil - Date.now();
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, remaining));
    return () => clearTimeout(timer);
  }, [unlockedUntil]);

  const unlocked = Boolean(unlockedUntil && unlockedUntil > now);

  const scoped = profile.databaseScope === 'selected';

  // Opening the modal (or switching connection) starts a fresh form. The
  // reset is applied while rendering, the way React recommends for state that
  // is derived from a prop, so the form never shows the previous values and
  // no effect has to cascade a render.
  const formKey = `${open}:${profile.id}`;
  const [lastFormKey, setLastFormKey] = useState(formKey);
  if (formKey !== lastFormKey) {
    setLastFormKey(formKey);
    setName('');
    setCharset('utf8mb4');
    setCollation('utf8mb4_general_ci');
    setAddToScope(true);
    setError(null);
    setResult(null);
    setLoadingCharsets(true);
  }

  useEffect(() => {
    if (!open) return;
    dbApi
      .listCharsets(profile.id)
      .then((items) => {
        setCharsets(items);
        const preferred = items.find((item) => item.charset === 'utf8mb4') ?? items[0] ?? null;
        if (preferred) {
          setCharset(preferred.charset);
          const defaultCollation =
            preferred.collations.find((item) => item.isDefault)?.name ??
            preferred.collations[0]?.name ??
            '';
          setCollation(defaultCollation);
        }
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setLoadingCharsets(false));
  }, [open, profile.id]);

  const collations = useMemo(
    () => charsets.find((item) => item.charset === charset)?.collations ?? [],
    [charsets, charset],
  );

  const charsetOptions = charsets.map((item) => ({
    value: item.charset,
    label: item.charset,
    description: `${item.collations.length} collations`,
  }));

  const collationOptions = collations.map((item) => ({
    value: item.name,
    label: item.name,
    description: item.isDefault ? 'server default for this charset' : undefined,
  }));

  const create = async (): Promise<void> => {
    setError(null);
    if (!IDENTIFIER.test(name.trim())) {
      setError('Use 1–64 letters, digits, or underscores for the database name.');
      return;
    }
    if (!charset || !collation) {
      setError('Choose a charset and collation.');
      return;
    }
    if (!unlocked) {
      setUnlockOpen(true);
      return;
    }
    setCreating(true);
    try {
      const created = await dbApi.createDatabase(profile.id, {
        name: name.trim(),
        charset,
        collation,
        addToScope: scoped && addToScope,
      });
      setResult(created);
      onCreated(created);
      toast(`Database "${created.database.name}" created.`, 'success');
    } catch (err) {
      if (err instanceof ApiError && err.code === 'WRITE_LOCKED') {
        setError('Unlock writes for this connection before creating a database.');
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setCreating(false);
    }
  };

  return (
    <>
      <Modal
        open={open}
        onClose={onClose}
        title={result ? 'Database created' : 'Create database'}
        size="default"
        footer={
          result ? (
            <Button variant="primary" onClick={onClose}>
              Done
            </Button>
          ) : (
            <>
              <Button variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button
                variant="primary"
                icon={creating ? <Spinner size={13} /> : <Database size={13} />}
                loading={creating}
                onClick={() => void create()}
                disabled={!name.trim() || loadingCharsets}
              >
                {unlocked ? 'Create database' : 'Unlock and create'}
              </Button>
            </>
          )
        }
      >
        {result ? (
          <div className="flex flex-col gap-3">
            <div className="callout mint flex items-start gap-2">
              <CheckCircle2 size={15} className="mt-0.5 shrink-0 text-mint" />
              <div className="text-[11px] text-muted">
                Charset {charset} · collation {result.database.collation ?? collation}
                {result.scopeUpdated ? ' · added to this connection’s allowed databases' : ''}
              </div>
            </div>
            {result.grantSql ? (
              <div className="rounded-xl border border-line-soft bg-panel-2/40 p-3">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <KeyRound size={13} className="text-ember" />
                  <span className="text-[12px] font-semibold">Least-privilege GRANT SQL</span>
                  <Badge tone="warn" className="ml-auto">
                    {notExecutedBadge}
                  </Badge>
                  <CopyButton text={result.grantSql} label="Copy SQL" />
                </div>
                <pre className="max-h-44 overflow-auto whitespace-pre-wrap font-mono text-[10px] text-ink-soft">
                  {result.grantSql}
                </pre>
                <div className="mt-2 text-[10px] leading-4 text-muted">
                  Replace the password placeholder before running this as an admin.
                </div>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {!unlocked ? (
              <div className="callout danger flex flex-wrap items-center gap-2">
                <Unlock size={14} className="text-danger" />
                <span className="flex-1">
                  Writes are locked. Creating a database is a DDL statement and needs an unlock.
                </span>
                <Button
                  variant="danger"
                  size="sm"
                  icon={<Unlock size={11} />}
                  onClick={() => setUnlockOpen(true)}
                >
                  Unlock writes
                </Button>
              </div>
            ) : null}

            <Field label="Database name">
              <Input
                className="font-mono"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="practice_db"
                autoFocus
              />
            </Field>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Character set">
                <Combobox
                  options={charsetOptions}
                  value={charset}
                  onChange={(value) => {
                    if (!value) return;
                    setCharset(value);
                    const next = charsets.find((item) => item.charset === value);
                    const defaultCollation =
                      next?.collations.find((item) => item.isDefault)?.name ??
                      next?.collations[0]?.name ??
                      '';
                    setCollation(defaultCollation);
                  }}
                  clearable={false}
                  disabled={loadingCharsets}
                />
              </Field>
              <Field label="Collation">
                <Combobox
                  options={collationOptions}
                  value={collation}
                  onChange={setCollation}
                  clearable={false}
                  disabled={loadingCharsets}
                />
              </Field>
            </div>

            {scoped ? (
              <Checkbox
                label="Add this database to the connection’s allowed scope"
                checked={addToScope}
                onChange={setAddToScope}
              />
            ) : null}

            {error ? <div className={cn('callout danger text-[11.5px]')}>{error}</div> : null}
          </div>
        )}
      </Modal>

      <UnlockDialog
        open={unlockOpen}
        classification={null}
        sql=""
        onClose={() => setUnlockOpen(false)}
        onProceed={() => undefined}
      />
    </>
  );
}
