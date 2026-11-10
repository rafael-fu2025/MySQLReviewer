import { Bookmark, ChevronRight, History, Plus, Save, Trash2 } from 'lucide-react';
import type { HistoryEntry, Snippet } from '@shared/types';
import { formatDate, formatDuration, sqlPreview } from '@/lib/format';
import {
  Badge,
  Button,
  EmptyState,
  Field,
  IconButton,
  Input,
  LoadingBlock,
  Modal,
  Spinner,
} from './ui';

export function WorkspaceModals({
  historyOpen,
  onCloseHistory,
  history,
  historyLoading,
  historySearch,
  onHistorySearch,
  onLoadHistory,
  onClearHistory,
  snippetsOpen,
  onCloseSnippets,
  snippets,
  snippetsLoading,
  snippetTitle,
  onSnippetTitle,
  snippetTags,
  onSnippetTags,
  snippetBusy,
  onSaveSnippet,
  onInsertSnippet,
  onDeleteSnippet,
}: {
  historyOpen: boolean;
  onCloseHistory: () => void;
  history: HistoryEntry[];
  historyLoading: boolean;
  historySearch: string;
  onHistorySearch: (value: string) => void;
  onLoadHistory: (entry: HistoryEntry, newTab: boolean) => void;
  onClearHistory: () => void;
  snippetsOpen: boolean;
  onCloseSnippets: () => void;
  snippets: Snippet[];
  snippetsLoading: boolean;
  snippetTitle: string;
  onSnippetTitle: (value: string) => void;
  snippetTags: string;
  onSnippetTags: (value: string) => void;
  snippetBusy: boolean;
  onSaveSnippet: () => void;
  onInsertSnippet: (text: string) => void;
  onDeleteSnippet: (id: string) => void;
}) {
  const needle = historySearch.trim().toLowerCase();
  const filtered = needle
    ? history.filter((entry) =>
        [entry.sql, entry.database ?? '', entry.kind].join(' ').toLowerCase().includes(needle),
      )
    : history;

  return (
    <>
      <Modal
        open={historyOpen}
        onClose={onCloseHistory}
        title="Query history"
        size="wide"
        footer={
          <Button
            variant="destructive"
            size="sm"
            icon={<Trash2 size={12} />}
            onClick={onClearHistory}
          >
            Clear history
          </Button>
        }
      >
        <div className="mb-3">
          <Input
            className="text-xs"
            placeholder="Filter history…"
            aria-label="Filter history"
            value={historySearch}
            onChange={(event) => onHistorySearch(event.target.value)}
          />
        </div>
        {historyLoading ? (
          <div className="flex items-center gap-2 py-8 text-xs text-muted">
            <Spinner size={14} /> Loading history…
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={<History size={20} />}
            title="No history yet"
            copy="Statements executed from this machine appear here."
          />
        ) : (
          <div className="flex max-h-[50vh] flex-col gap-2 overflow-auto">
            {filtered.map((entry) => (
              // `history-row` carries the modal rows' staggered entrance
              // (modal-toast.css).
              <div
                key={entry.id}
                className="history-row rounded-lg border border-line-soft bg-panel-2 p-3"
              >
                <div className="flex flex-wrap items-center gap-2 text-2xs text-muted">
                  <Badge tone={entry.success ? 'mint' : 'danger'}>
                    {entry.success ? 'ok' : 'error'}
                  </Badge>
                  <span className="font-mono text-2xs text-muted">{entry.kind}</span>
                  <span>{formatDate(entry.createdAt)}</span>
                  <span>{formatDuration(entry.executionMs)}</span>
                  {entry.database ? <span className="font-mono">{entry.database}</span> : null}
                  <div className="ml-auto flex gap-1">
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => onLoadHistory(entry, false)}
                    >
                      Load
                    </Button>
                    <Button
                      variant="tertiary"
                      size="sm"
                      icon={<Plus size={11} />}
                      onClick={() => onLoadHistory(entry, true)}
                    >
                      Load in new tab
                    </Button>
                  </div>
                </div>
                <div className="mt-2 max-h-20 overflow-auto whitespace-pre-wrap font-mono text-2xs text-ink-soft">
                  {sqlPreview(entry.sql, 600)}
                </div>
                {entry.error ? (
                  <div className="mt-1 text-2xs text-danger">{entry.error}</div>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </Modal>

      <Modal open={snippetsOpen} onClose={onCloseSnippets} title="Saved snippets" size="wide">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-[1fr_260px]">
          <div className="flex max-h-[55vh] flex-col gap-2 overflow-auto">
            {snippetsLoading && snippets.length === 0 ? (
              // The list is fetched when the modal opens; a first open shows
              // shimmer lines instead of silently sitting on the empty state.
              // A refresh over an existing list keeps it on screen.
              <LoadingBlock lines={4} />
            ) : snippets.length === 0 ? (
              <EmptyState icon={<Bookmark size={20} />} title="No snippets saved" />
            ) : (
              snippets.map((snippet) => (
                <div
                  key={snippet.id}
                  className="snippet-row rounded-lg border border-line-soft bg-panel-2 p-3"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs font-semibold text-ink">{snippet.title}</span>
                    {snippet.tags.map((tag) => (
                      <span key={tag} className="text-2xs text-muted">
                        {tag}
                      </span>
                    ))}
                    <div className="ml-auto flex gap-1">
                      <Button
                        variant="secondary"
                        size="sm"
                        icon={<ChevronRight size={11} />}
                        onClick={() => onInsertSnippet(snippet.sql)}
                      >
                        Insert
                      </Button>
                      <IconButton
                        label="Delete snippet"
                        onClick={() => onDeleteSnippet(snippet.id)}
                      >
                        <Trash2 size={12} />
                      </IconButton>
                    </div>
                  </div>
                  <div className="mt-2 max-h-24 overflow-auto whitespace-pre-wrap font-mono text-2xs text-muted">
                    {sqlPreview(snippet.sql, 600)}
                  </div>
                </div>
              ))
            )}
          </div>
          <div className="flex flex-col gap-2 rounded-xl border border-line-soft bg-panel-2 p-3">
            <div className="flex items-center gap-2 text-xs font-semibold">
              <Save size={13} className="text-ember" /> Save current SQL
            </div>
            <Field label="Title">
              <Input
                value={snippetTitle}
                onChange={(event) => onSnippetTitle(event.target.value)}
                placeholder="Top customers"
              />
            </Field>
            <Field label="Tags" hint="Comma separated.">
              <Input
                value={snippetTags}
                onChange={(event) => onSnippetTags(event.target.value)}
                placeholder="reporting, orders"
              />
            </Field>
            <Button
              variant="primary"
              size="sm"
              loading={snippetBusy}
              icon={<Save size={12} />}
              onClick={onSaveSnippet}
            >
              Save snippet
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
