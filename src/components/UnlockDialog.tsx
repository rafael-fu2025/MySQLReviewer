import { useState } from 'react';
import { AlertOctagon, ShieldAlert, Unlock } from 'lucide-react';
import type { StatementClassification } from '@shared/types';
import { useAppStore } from '@/store/app-store';
import { Button, Checkbox, Field, Input, Modal, Spinner } from './ui';
import { cn } from '@/lib/utils';

export function UnlockDialog({
  open,
  classification,
  sql,
  onClose,
  onProceed,
}: {
  open: boolean;
  classification: StatementClassification | null;
  sql: string;
  onClose: () => void;
  onProceed: () => void;
}) {
  const unlockWrites = useAppStore((state) => state.unlockWrites);
  const [phrase, setPhrase] = useState('');
  const [step, setStep] = useState<'unlock' | 'confirm'>('unlock');
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Every time the dialog opens it starts from a clean unlock form. Adjusting
  // the state while rendering keeps the reset in the same commit as the open,
  // instead of running a second render from an effect.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setPhrase('');
      setStep('unlock');
      setAcknowledged(false);
      setBusy(false);
      setError(null);
    }
  }

  const confirmUnlock = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await unlockWrites(phrase);
      if (classification?.destructive) {
        setStep('confirm');
      } else {
        onClose();
        if (classification) onProceed();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const proceed = (): void => {
    onClose();
    onProceed();
  };

  const title = classification?.destructive
    ? 'This statement can destroy data'
    : classification
      ? 'Writes are locked'
      : 'Unlock writes';

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      subtitle="Unlocking is per connection and lasts 15 minutes."
      size={step === 'confirm' ? 'wide' : 'narrow'}
      footer={
        step === 'unlock' ? (
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="danger"
              icon={busy ? <Spinner size={13} /> : <Unlock size={13} />}
              loading={busy}
              disabled={phrase.trim().toUpperCase() !== 'UNLOCK WRITES'}
              onClick={() => void confirmUnlock()}
            >
              Unlock writes
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="danger"
              icon={<AlertOctagon size={13} />}
              disabled={!acknowledged}
              onClick={proceed}
            >
              Run this statement
            </Button>
          </>
        )
      }
    >
      {step === 'unlock' ? (
        <div className="flex flex-col gap-3">
          <div className="callout danger flex items-start gap-2">
            <ShieldAlert size={15} className="mt-0.5 shrink-0" />
            <div>
              {classification?.reason ??
                'DML, DDL, and administrative statements will be allowed for this connection.'}
            </div>
          </div>
          {sql ? (
            <div>
              <div className="mono-label mb-1">Statement waiting to run</div>
              <pre className="code-block max-h-40 whitespace-pre-wrap text-[10.5px]">{sql}</pre>
            </div>
          ) : null}
          <Field label="Type UNLOCK WRITES to continue" error={error}>
            <Input
              className={cn(
                'font-mono uppercase tracking-wider',
                phrase.trim().toUpperCase() === 'UNLOCK WRITES' &&
                  'border-danger/60 focus:border-danger',
              )}
              value={phrase}
              onChange={(event) => setPhrase(event.target.value)}
              placeholder="UNLOCK WRITES"
              autoFocus
              onKeyDown={(event) => {
                if (event.key === 'Enter' && phrase.trim().toUpperCase() === 'UNLOCK WRITES') {
                  event.preventDefault();
                  void confirmUnlock();
                }
              }}
            />
          </Field>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="callout danger flex items-start gap-2">
            <AlertOctagon size={16} className="mt-0.5 shrink-0" />
            <div>
              <div className="font-semibold text-ink">
                {classification?.destructive
                  ? 'This statement is classified as destructive.'
                  : 'Run the unlocked statement.'}
              </div>
              <div className="mt-1 text-[11.5px] text-muted">
                {classification?.reason ?? 'Verify the target and keep a backup before proceeding.'}
              </div>
            </div>
          </div>
          {sql ? (
            <div>
              <div className="mono-label mb-1">Statement</div>
              <pre className="code-block max-h-56 whitespace-pre-wrap text-[10.5px]">{sql}</pre>
            </div>
          ) : null}
          <Checkbox
            label="I understand this statement may permanently change schema or data, and I have verified the target."
            checked={acknowledged}
            onChange={setAcknowledged}
          />
        </div>
      )}
    </Modal>
  );
}
