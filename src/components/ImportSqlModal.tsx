import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, FileUp, Play, Unlock, XCircle } from 'lucide-react';
import type { ConnectionProfile } from '@shared/types';
import {
  dbApi,
  runImportStatements,
  shortenSql,
  type ImportPreviewResult,
  type ImportRunOutcome,
} from '@/lib/db-api';
import { formatBytes, formatNumber } from '@/lib/format';
import { useAppStore } from '@/store/app-store';
import { UnlockDialog } from './UnlockDialog';
import { Badge, Button, Modal, ProgressBar, Spinner, Textarea } from './ui';

/** The error codes that mean the write unlock is missing. */
const LOCK_CODES = new Set(['WRITE_LOCKED', 'REVEAL_LOCKED']);

/** The badge tone of a statement kind. */
function kindTone(kind: string): 'neutral' | 'ember' | 'mint' | 'danger' | 'warn' | 'info' {
  switch (kind) {
    case 'read':
      return 'info';
    case 'write':
      return 'ember';
    case 'ddl':
      return 'warn';
    case 'admin':
      return 'danger';
    default:
      return 'neutral';
  }
}

/**
 * Where the script comes from: a `.sql` file on disk, or SQL pasted straight
 * into the box. Kept apart from the modal so it can be rendered on its own.
 */
export function ImportSqlSource({
  fileName,
  pasted,
  status,
  onFilePicked,
  onPastedChange,
  onReviewPasted,
}: {
  fileName: string | null;
  pasted: string;
  status: 'idle' | 'previewing' | 'ready' | 'running' | 'done';
  onFilePicked: (file: File) => void;
  onPastedChange: (value: string) => void;
  onReviewPasted: () => void;
}) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const busy = status === 'running';
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={fileInputRef}
          type="file"
          accept=".sql"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            // Clearing the input lets the same file be chosen again.
            event.target.value = '';
            if (file) onFilePicked(file);
          }}
        />
        <Button
          variant="primary"
          size="sm"
          icon={<FileUp size={12} />}
          onClick={() => fileInputRef.current?.click()}
          disabled={busy}
        >
          Choose .sql file
        </Button>
        {fileName ? (
          <span className="truncate font-mono text-2xs text-ink-soft">{fileName}</span>
        ) : (
          <span className="text-2xs text-muted">No file chosen yet.</span>
        )}
        {status === 'previewing' ? (
          <span className="flex items-center gap-1 text-2xs text-muted">
            <Spinner size={12} /> Reading the file...
          </span>
        ) : null}
      </div>

      <div className="flex flex-col gap-2">
        <label className="text-2xs font-semibold text-ink-soft" htmlFor="import-sql-paste">
          Or paste SQL
        </label>
        <Textarea
          id="import-sql-paste"
          className="min-h-24 font-mono text-2xs"
          placeholder={'CREATE TABLE ...\nINSERT INTO ...'}
          value={pasted}
          onChange={(event) => onPastedChange(event.target.value)}
          disabled={busy}
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            disabled={!pasted.trim() || busy}
            onClick={onReviewPasted}
          >
            Review pasted SQL
          </Button>
          <span className="text-2xs text-muted">
            Statements are parsed and shown for review. Nothing runs until you press Run.
          </span>
        </div>
      </div>
    </div>
  );
}

/**
 * Import a `.sql` file.
 *
 * The file is parsed and shown for review; nothing is executed until the user
 * presses Run. The run then sends every statement of that list on its own
 * through the ordinary query path, so the write unlock, the member scope and
 * the masking all apply to each of them.
 */
export function ImportSqlModal({
  open,
  onClose,
  profile,
  database,
}: {
  open: boolean;
  onClose: () => void;
  profile: ConnectionProfile;
  database: string | null;
}) {
  const unlockedUntil = useAppStore((state) => state.unlockedUntil);
  const currentUser = useAppStore((state) => state.currentUser);
  const toast = useAppStore((state) => state.toast);
  const [fileName, setFileName] = useState<string | null>(null);
  const [pasted, setPasted] = useState('');
  const [preview, setPreview] = useState<ImportPreviewResult | null>(null);
  const [outcomes, setOutcomes] = useState<ImportRunOutcome[]>([]);
  const [status, setStatus] = useState<'idle' | 'previewing' | 'ready' | 'running' | 'done'>(
    'idle',
  );
  const [error, setError] = useState<string | null>(null);
  const [lockedFailures, setLockedFailures] = useState(0);
  const [lockMessage, setLockMessage] = useState<string | null>(null);
  const [unlockOpen, setUnlockOpen] = useState(false);

  const isAdmin = currentUser?.role === 'admin';

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

  const unlocked = isAdmin || Boolean(unlockedUntil && unlockedUntil > now);

  // Opening the modal (or switching connection) starts a clean sheet. The
  // reset is applied while rendering, the way React recommends for state that
  // is derived from a prop.
  const formKey = `${open}:${profile.id}:${database ?? ''}`;
  const [lastFormKey, setLastFormKey] = useState(formKey);
  if (formKey !== lastFormKey) {
    setLastFormKey(formKey);
    setFileName(null);
    setPasted('');
    setPreview(null);
    setOutcomes([]);
    setStatus('idle');
    setError(null);
    setLockedFailures(0);
    setLockMessage(null);
  }

  /**
   * Parse a script and show it for review. Nothing is executed here: the run
   * is a separate, explicit step.
   */
  const reviewSql = async (text: string, name: string | null): Promise<void> => {
    setFileName(name);
    setError(null);
    setPreview(null);
    setOutcomes([]);
    setLockedFailures(0);
    setLockMessage(null);
    setStatus('previewing');
    try {
      const result = await dbApi.previewImport(profile.id, { sql: text, database });
      setPreview(result);
      setStatus('ready');
    } catch (err) {
      setStatus('idle');
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleFilePicked = async (file: File): Promise<void> => {
    await reviewSql(await file.text(), file.name);
  };

  const run = async (): Promise<void> => {
    if (!preview || preview.statements.length === 0) return;
    const statements = preview.statements;
    setStatus('running');
    setError(null);
    setLockedFailures(0);
    setLockMessage(null);
    setOutcomes(statements.map(() => ({ status: 'pending' as const, error: null, code: null })));

    const results = await runImportStatements(
      statements,
      async (statement, index) => {
        setOutcomes((current) =>
          current.map((outcome, position) =>
            position === index ? { ...outcome, status: 'running' } : outcome,
          ),
        );
        // One statement per request, through the ordinary query path, so every
        // gate that guards a write applies to this statement as well.
        await dbApi.run(profile.id, statement.sql, database, { revealSensitive: false });
      },
      (index, outcome) => {
        setOutcomes((current) =>
          current.map((entry, position) => (position === index ? outcome : entry)),
        );
        if (outcome.code && LOCK_CODES.has(outcome.code)) {
          setLockedFailures((count) => count + 1);
          setLockMessage((message) => message ?? outcome.error);
        }
      },
    );

    setOutcomes(results);
    setStatus('done');
    const failed = results.filter((outcome) => outcome.status === 'failed').length;
    const skipped = results.filter((outcome) => outcome.status === 'skipped').length;
    const ok = results.filter((outcome) => outcome.status === 'ok').length;
    const skippedNote = skipped > 0 ? `, ${skipped} skipped` : '';
    if (failed === 0) {
      toast(`Imported ${ok} statement${ok === 1 ? '' : 's'}${skippedNote}.`, 'success');
    } else {
      toast(
        `Imported ${ok} statement${ok === 1 ? '' : 's'}, ${failed} failed${skippedNote}.`,
        'warn',
      );
    }
  };

  const total = preview?.statements.length ?? 0;
  const finished = outcomes.filter(
    (outcome) =>
      outcome.status === 'ok' || outcome.status === 'failed' || outcome.status === 'skipped',
  ).length;
  const failed = outcomes.filter((outcome) => outcome.status === 'failed').length;
  const skipped = outcomes.filter((outcome) => outcome.status === 'skipped').length;
  const succeeded = outcomes.filter((outcome) => outcome.status === 'ok').length;

  return (
    <>
      <Modal
        open={open}
        onClose={onClose}
        title="Import SQL"
        subtitle={database ? `Runs against ${database}` : 'Runs against the connection default'}
        size="default"
        footer={
          <>
            <Button variant="tertiary" onClick={onClose} disabled={status === 'running'}>
              {status === 'done' ? 'Close' : 'Cancel'}
            </Button>
            {status === 'running' ? (
              <Button variant="primary" icon={<Spinner size={13} />} loading disabled>
                Running {finished + 1} of {total}
              </Button>
            ) : preview && preview.statements.length > 0 ? (
              <Button variant="primary" icon={<Play size={13} />} onClick={() => void run()}>
                Run {total} statement{total === 1 ? '' : 's'}
              </Button>
            ) : null}
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <ImportSqlSource
            fileName={fileName}
            pasted={pasted}
            status={status}
            onFilePicked={(file) => void handleFilePicked(file)}
            onPastedChange={setPasted}
            onReviewPasted={() => void reviewSql(pasted, 'Pasted SQL')}
          />

          {error ? <div className="callout danger text-2xs">{error}</div> : null}

          {preview ? (
            <>
              <div className="flex flex-wrap items-center gap-2 text-2xs text-muted">
                <Badge tone="info">{formatNumber(preview.statements.length)} statements</Badge>
                {preview.needsUnlockCount > 0 ? (
                  <Badge tone="warn">
                    {formatNumber(preview.needsUnlockCount)} need the write unlock
                  </Badge>
                ) : null}
                {preview.destructiveCount > 0 ? (
                  <Badge tone="danger">{formatNumber(preview.destructiveCount)} destructive</Badge>
                ) : null}
                <Badge tone="neutral">{formatBytes(preview.bytes)}</Badge>
                {preview.sessionCount ? (
                  <Badge tone="neutral">
                    {formatNumber(preview.sessionCount)} session settings
                  </Badge>
                ) : null}
              </div>

              {preview.destructiveStatements && preview.destructiveStatements.length > 0 ? (
                <div className="callout danger text-2xs">
                  This file drops or truncates something:{' '}
                  <span className="font-mono">{preview.destructiveStatements.join(', ')}</span>.
                  Those statements will run.
                </div>
              ) : null}

              {preview.sessionCount ? (
                <div className="callout info text-2xs">
                  {formatNumber(preview.sessionCount)} statement
                  {preview.sessionCount === 1 ? '' : 's'} only change session state (SET, USE) and
                  will be skipped - this import runs against the database you have selected.
                </div>
              ) : null}

              {preview.hasDelimiter ? (
                <div className="callout info text-2xs">
                  This file uses a <span className="font-mono">DELIMITER</span> directive, so the
                  statements have already been split correctly.
                </div>
              ) : null}

              {preview.needsUnlockCount > 0 && !unlocked ? (
                <div className="callout danger flex flex-wrap items-center gap-2">
                  <Unlock size={14} className="text-danger" />
                  <span className="flex-1">
                    {formatNumber(preview.needsUnlockCount)} of these statements need the write
                    unlock before they can run.
                  </span>
                  <Button
                    variant="destructive"
                    size="sm"
                    icon={<Unlock size={11} />}
                    onClick={() => setUnlockOpen(true)}
                  >
                    Unlock writes
                  </Button>
                </div>
              ) : null}

              {status === 'running' ? (
                <div className="flex flex-col gap-1">
                  <div className="text-2xs text-muted">
                    Running {finished + 1} of {total}...
                  </div>
                  <ProgressBar percent={total === 0 ? 0 : (finished / total) * 100} />
                </div>
              ) : null}

              {status === 'done' ? (
                <div
                  className={
                    failed === 0
                      ? 'callout mint flex items-start gap-2'
                      : 'callout danger flex items-start gap-2'
                  }
                >
                  {failed === 0 ? (
                    <CheckCircle2 size={15} className="mt-0.5 shrink-0 text-mint" />
                  ) : (
                    <AlertTriangle size={15} className="mt-0.5 shrink-0 text-danger" />
                  )}
                  <div className="text-2xs text-muted">
                    {formatNumber(succeeded)} of {formatNumber(total)} statements ran.{' '}
                    {skipped > 0 ? `${formatNumber(skipped)} session settings were skipped. ` : ''}
                    {failed > 0
                      ? `${formatNumber(failed)} failed and are listed below.`
                      : 'Nothing failed.'}
                  </div>
                </div>
              ) : null}

              {lockedFailures > 0 ? (
                <div className="callout danger flex flex-wrap items-center gap-2">
                  <Unlock size={14} className="text-danger" />
                  <span className="flex-1">
                    Writes are locked, so {formatNumber(lockedFailures)} statement
                    {lockedFailures === 1 ? '' : 's'} could not run. {lockMessage ?? ''}
                  </span>
                  <Button
                    variant="destructive"
                    size="sm"
                    icon={<Unlock size={11} />}
                    onClick={() => setUnlockOpen(true)}
                  >
                    Unlock writes
                  </Button>
                </div>
              ) : null}

              <div className="max-h-80 overflow-auto rounded-xl border border-line-soft">
                {preview.statements.map((statement, index) => {
                  const outcome = outcomes[index];
                  const locked = outcome?.code != null && LOCK_CODES.has(outcome.code);
                  return (
                    <div
                      key={`${index}-${statement.kind}`}
                      className="flex items-start gap-2 border-b border-line-soft px-2 py-1.5 last:border-b-0"
                    >
                      <span className="mt-0.5 w-6 shrink-0 font-mono text-2xs text-muted">
                        {index + 1}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1">
                          <Badge tone={kindTone(statement.kind)}>{statement.kind}</Badge>
                          {statement.needsUnlock ? <Badge tone="warn">needs unlock</Badge> : null}
                          {statement.destructive ? <Badge tone="danger">destructive</Badge> : null}
                        </div>
                        <div className="mt-1 truncate font-mono text-2xs text-ink-soft">
                          {shortenSql(statement.sql)}
                        </div>
                        {outcome?.status === 'failed' ? (
                          <div className="mt-1 flex items-start gap-1 text-2xs text-danger">
                            <XCircle size={11} className="mt-0.5 shrink-0" />
                            <span>{locked ? 'Needs the write unlock.' : outcome.error}</span>
                          </div>
                        ) : null}
                      </div>
                      <div className="shrink-0 pt-0.5">
                        {outcome?.status === 'running' ? (
                          <Spinner size={13} />
                        ) : outcome?.status === 'ok' ? (
                          <CheckCircle2 size={13} className="text-mint" />
                        ) : outcome?.status === 'failed' ? (
                          <XCircle size={13} className="text-danger" />
                        ) : (
                          <span className="text-2xs text-muted">-</span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          ) : null}
        </div>
      </Modal>

      <UnlockDialog
        open={!isAdmin && unlockOpen}
        classification={null}
        sql=""
        onClose={() => setUnlockOpen(false)}
        onProceed={() => undefined}
      />
    </>
  );
}
