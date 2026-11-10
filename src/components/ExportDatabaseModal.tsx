import { useEffect, useState } from 'react';
import { CheckCircle2, Database, Download, Unlock } from 'lucide-react';
import type { ConnectionProfile } from '@shared/types';
import { dbApi, type DatabaseExportStats } from '@/lib/db-api';
import { ApiError, downloadText } from '@/lib/api';
import { formatBytes, formatNumber } from '@/lib/format';
import { useAppStore } from '@/store/app-store';
import { UnlockDialog } from './UnlockDialog';
import { Badge, Button, Checkbox, Field, Input, Modal, Spinner, StatCard } from './ui';

/** The server refuses a larger row limit than this. */
const MAX_ROW_LIMIT = 1_000_000;

/**
 * Dump one database to a `.sql` file.
 *
 * The dump is a script, not a data channel: it is downloaded as a file and,
 * when it is imported again, every statement is reviewed before it runs. The
 * rows of a table carry the raw value of every column, so exporting them is a
 * write-level action and needs the same unlock as the table browser.
 */
export function ExportDatabaseModal({
  open,
  onClose,
  profile,
  database,
}: {
  open: boolean;
  onClose: () => void;
  profile: ConnectionProfile;
  database: string;
}) {
  const unlockedUntil = useAppStore((state) => state.unlockedUntil);
  const currentUser = useAppStore((state) => state.currentUser);
  const toast = useAppStore((state) => state.toast);
  const [includeData, setIncludeData] = useState(false);
  const [includeObjects, setIncludeObjects] = useState(true);
  const [rowLimit, setRowLimit] = useState('0');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [locked, setLocked] = useState(false);
  const [stats, setStats] = useState<DatabaseExportStats | null>(null);
  const [filename, setFilename] = useState<string | null>(null);
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

  // Opening the modal (or switching connection) starts a fresh form. The
  // reset is applied while rendering, the way React recommends for state that
  // is derived from a prop, so the form never shows the previous values.
  const formKey = `${open}:${profile.id}:${database}`;
  const [lastFormKey, setLastFormKey] = useState(formKey);
  if (formKey !== lastFormKey) {
    setLastFormKey(formKey);
    setIncludeData(false);
    setIncludeObjects(true);
    setRowLimit('0');
    setRunning(false);
    setError(null);
    setLocked(false);
    setStats(null);
    setFilename(null);
  }

  const run = async (): Promise<void> => {
    setError(null);
    setLocked(false);
    const parsed = Number.parseInt(rowLimit, 10);
    const limit = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, MAX_ROW_LIMIT) : 0;
    setRunning(true);
    try {
      const result = await dbApi.exportDatabase(profile.id, database, {
        includeData,
        includeObjects,
        rowLimit: limit,
      });
      downloadText(result.filename, result.sql, 'application/sql;charset=utf-8');
      setStats(result.stats);
      setFilename(result.filename);
      toast(`Exported ${result.filename}.`, 'success');
    } catch (err) {
      if (err instanceof ApiError && err.code === 'REVEAL_LOCKED') {
        // The server refused the rows because the write unlock is missing.
        // Say so plainly and point at the unlock, instead of failing silently.
        setLocked(true);
        setError(err.message);
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setRunning(false);
    }
  };

  return (
    <>
      <Modal
        open={open}
        onClose={onClose}
        title={stats ? 'Export complete' : 'Export database'}
        subtitle={database}
        size="default"
        footer={
          stats ? (
            <Button variant="primary" onClick={onClose}>
              Done
            </Button>
          ) : (
            <>
              <Button variant="tertiary" onClick={onClose}>
                Cancel
              </Button>
              <Button
                variant="primary"
                icon={running ? <Spinner size={13} /> : <Download size={13} />}
                loading={running}
                onClick={() => void run()}
              >
                Run export
              </Button>
            </>
          )
        }
      >
        {stats ? (
          <div className="flex flex-col gap-3">
            <div className="callout mint flex items-start gap-2">
              <CheckCircle2 size={15} className="mt-0.5 shrink-0 text-mint" />
              <div className="text-2xs text-muted">
                <span className="font-mono text-ink-soft">{filename}</span> was downloaded to your
                machine. Import it again with "Import SQL" to run its statements.
              </div>
            </div>
            <div className="stat-grid stat-grid-6">
              <StatCard label="Tables" value={formatNumber(stats.tables)} />
              <StatCard label="Views" value={formatNumber(stats.views)} />
              <StatCard label="Triggers" value={formatNumber(stats.triggers)} />
              <StatCard label="Routines" value={formatNumber(stats.routines)} />
              <StatCard label="Rows" value={formatNumber(stats.rows)} />
              <StatCard label="Size" value={formatBytes(stats.bytes)} />
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex items-start gap-2 text-2xs text-muted">
              <Database size={14} className="mt-0.5 shrink-0 text-ember" />
              <span>
                The dump holds the schema of every table in{' '}
                <span className="font-mono text-ink-soft">{database}</span>, in the shape mysqldump
                produces.
              </span>
            </div>

            {includeData && !unlocked && !locked ? (
              <div className="callout danger flex flex-wrap items-center gap-2">
                <Unlock size={14} className="text-danger" />
                <span className="flex-1">
                  Writes are locked. Exporting the rows of a database needs an unlock.
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

            <div className="flex flex-col gap-2">
              <Checkbox
                label="Include data (rows)"
                checked={includeData}
                onChange={setIncludeData}
              />
              <Checkbox
                label="Include views, triggers and routines"
                checked={includeObjects}
                onChange={setIncludeObjects}
              />
            </div>

            {includeData ? (
              <Field
                label="Max rows per table"
                hint="0 exports every row. The server refuses a limit above 1,000,000."
              >
                <Input
                  type="number"
                  min={0}
                  max={MAX_ROW_LIMIT}
                  value={rowLimit}
                  onChange={(event) => setRowLimit(event.target.value)}
                />
              </Field>
            ) : null}

            {error ? (
              <div className="callout danger flex flex-wrap items-center gap-2 text-2xs">
                <span className="flex-1">{error}</span>
                {locked ? (
                  <Button
                    variant="destructive"
                    size="sm"
                    icon={<Unlock size={11} />}
                    onClick={() => setUnlockOpen(true)}
                  >
                    Unlock writes
                  </Button>
                ) : null}
              </div>
            ) : null}

            <div className="flex items-center gap-2 text-2xs text-muted">
              <Badge tone="neutral">schema only</Badge>
              {includeData ? <Badge tone="warn">rows included</Badge> : null}
              {includeObjects ? <Badge tone="info">objects included</Badge> : null}
            </div>
          </div>
        )}
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
