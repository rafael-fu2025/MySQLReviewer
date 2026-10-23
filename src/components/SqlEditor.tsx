import { useCallback, useEffect, useMemo, useState } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { MySQL, sql } from '@codemirror/lang-sql';
import { EditorState, Prec } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { lintGutter, linter, type Diagnostic } from '@codemirror/lint';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import type { SchemaSummary, StaticReviewResult } from '@shared/types';
import { api } from '@/lib/api';

const highlight = HighlightStyle.define([
  { tag: tags.keyword, color: 'var(--cm-keyword)', fontWeight: '600' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--cm-string)' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--cm-number)' },
  {
    tag: [tags.comment, tags.lineComment, tags.blockComment],
    color: 'var(--cm-comment)',
    fontStyle: 'italic',
  },
  { tag: [tags.variableName, tags.name], color: 'var(--cm-variable)' },
  { tag: tags.function(tags.variableName), color: 'var(--cm-function)' },
  { tag: [tags.operator, tags.punctuation], color: 'var(--cm-operator)' },
  { tag: tags.typeName, color: 'var(--cm-type)' },
  { tag: [tags.propertyName, tags.attributeName], color: 'var(--cm-property)' },
]);

const editorTheme = EditorView.theme(
  {
    '&': {
      backgroundColor: 'transparent',
      color: 'var(--color-ink)',
      height: '100%',
    },
    '.cm-content': {
      caretColor: 'var(--color-ember)',
      padding: '10px 0 30px',
    },
    '.cm-cursor, .cm-dropCursor': {
      borderLeftColor: 'var(--color-ember)',
    },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
      backgroundColor: 'var(--cm-selection) !important',
    },
    '.cm-gutters': {
      backgroundColor: 'transparent',
      color: 'color-mix(in oklab, var(--color-muted) 55%, transparent)',
      border: 'none',
    },
    '.cm-activeLineGutter': {
      backgroundColor: 'color-mix(in oklab, var(--color-ember) 6%, transparent)',
      color: 'var(--color-ember)',
    },
    '.cm-activeLine': {
      backgroundColor: 'color-mix(in oklab, var(--color-ember) 4%, transparent)',
    },
    '.cm-tooltip': {
      backgroundColor: 'var(--color-panel-2)',
      border: '1px solid var(--color-line)',
      borderRadius: '8px',
      color: 'var(--color-ink)',
    },
    '.cm-tooltip-autocomplete ul li[aria-selected]': {
      backgroundColor: 'color-mix(in oklab, var(--color-ember) 18%, transparent)',
      color: 'var(--color-ink)',
    },
    '.cm-panels': {
      backgroundColor: 'var(--color-panel-2)',
      color: 'var(--color-ink)',
    },
  },
  { dark: true },
);

type EditorHandlers = {
  onChange: (value: string) => void;
  onRun: () => void;
  onRunSelection: () => void;
  onReview: () => void;
};

/**
 * Holds the newest editor handlers.
 *
 * CodeMirror reconfigures every extension whenever the `extensions` array
 * changes identity, so the key bindings are built once and still have to
 * reach the latest props. A ref cannot carry them here: React's compiler
 * rejects a render-phase closure that reads a ref when it is handed to
 * `keymap.of`, and the extension has to be built while rendering. The cell is
 * filled in an effect, so it is never written during render either.
 */
class HandlerCell {
  private handlers: EditorHandlers;

  constructor(initial: EditorHandlers) {
    this.handlers = initial;
  }

  set(next: EditorHandlers): void {
    this.handlers = next;
  }

  get(): EditorHandlers {
    return this.handlers;
  }
}

function severityFor(severity: string): Diagnostic['severity'] {
  if (severity === 'critical' || severity === 'high') return 'error';
  if (severity === 'medium') return 'warning';
  return 'info';
}

// Module-level constants: recreating these per render would force CodeMirror to
// reconfigure the whole editor on every keystroke.
const highlightExtension = syntaxHighlighting(highlight);
const tabSizeExtension = EditorState.tabSize.of(2);

export function SqlEditor({
  value,
  onChange,
  schema,
  profileId,
  database,
  liveLint,
  onRun,
  onRunSelection,
  onReview,
  onReady,
}: {
  value: string;
  onChange: (value: string) => void;
  schema: SchemaSummary | null;
  profileId: string | null;
  database: string | null;
  liveLint: boolean;
  onRun: () => void;
  onRunSelection: () => void;
  onReview: () => void;
  onReady: (view: EditorView) => void;
}) {
  // CodeMirror reconfigures every extension whenever `extensions` or `onChange`
  // changes identity, so both must stay stable across renders. Callbacks are
  // routed through a cell to always invoke the latest props without rebuilding.
  const [handlers] = useState(() => new HandlerCell({ onChange, onRun, onRunSelection, onReview }));

  useEffect(() => {
    handlers.set({ onChange, onRun, onRunSelection, onReview });
  });

  const handleChange = useCallback(
    (next: string): void => {
      handlers.get().onChange(next);
    },
    [handlers],
  );

  const sqlExtension = useMemo(() => {
    const schemaObject: Record<string, string[]> = {};
    for (const table of schema?.tables ?? []) {
      schemaObject[table.name] = table.columns;
    }
    return sql({
      dialect: MySQL,
      schema: schemaObject,
      upperCaseKeywords: true,
    });
  }, [schema]);

  const lintExtensions = useMemo(() => {
    if (!liveLint || !profileId || !database) return [];
    return [
      lintGutter(),
      linter(
        async (view): Promise<Diagnostic[]> => {
          const text = view.state.doc.toString();
          if (text.trim().length < 4) return [];
          try {
            const result = await api.post<StaticReviewResult>('/api/review/static', {
              profileId,
              database,
              sql: text,
              includeSchema: true,
            });
            const diagnostics: Diagnostic[] = [];
            for (const finding of result.findings) {
              if (!finding.line) continue;
              if (finding.line < 1 || finding.line > view.state.doc.lines) continue;
              const line = view.state.doc.line(finding.line);
              const to = Math.min(view.state.doc.length, Math.max(line.from + 1, line.to));
              diagnostics.push({
                from: line.from,
                to,
                severity: severityFor(finding.severity),
                message: `${finding.title}\n${finding.message}`,
                source: finding.ruleId,
              });
            }
            return diagnostics;
          } catch {
            return [];
          }
        },
        { delay: 900 },
      ),
    ];
  }, [database, liveLint, profileId]);

  const keymapExtension = useMemo(
    () =>
      Prec.highest(
        keymap.of([
          {
            key: 'Mod-Enter',
            preventDefault: true,
            run: () => {
              handlers.get().onRun();
              return true;
            },
          },
          {
            key: 'Shift-Mod-Enter',
            preventDefault: true,
            run: () => {
              handlers.get().onRunSelection();
              return true;
            },
          },
          {
            key: 'Shift-Mod-r',
            preventDefault: true,
            run: () => {
              handlers.get().onReview();
              return true;
            },
          },
        ]),
      ),
    [handlers],
  );

  const extensions = useMemo(
    () => [
      // Long statements continue on the next line instead of running off the
      // edge of the editor. `basicSetup` has no lineWrapping option, so the
      // extension has to be added directly.
      EditorView.lineWrapping,
      sqlExtension,
      highlightExtension,
      tabSizeExtension,
      ...lintExtensions,
      keymapExtension,
    ],
    [keymapExtension, lintExtensions, sqlExtension],
  );

  return (
    <CodeMirror
      value={value}
      height="100%"
      className="h-full"
      theme={editorTheme}
      extensions={extensions}
      basicSetup={{
        lineNumbers: true,
        highlightActiveLineGutter: true,
        highlightSpecialChars: true,
        history: true,
        foldGutter: true,
        drawSelection: true,
        dropCursor: true,
        allowMultipleSelections: true,
        indentOnInput: true,
        syntaxHighlighting: false,
        bracketMatching: true,
        closeBrackets: true,
        autocompletion: true,
        rectangularSelection: true,
        crosshairCursor: false,
        highlightActiveLine: true,
        highlightSelectionMatches: true,
        closeBracketsKeymap: true,
        defaultKeymap: true,
        searchKeymap: true,
        historyKeymap: true,
        foldKeymap: true,
        completionKeymap: true,
        lintKeymap: true,
      }}
      onCreateEditor={(view) => {
        onReady(view);
      }}
      onChange={handleChange}
      placeholder="-- MySQL runs here. Press Ctrl+Enter to execute."
    />
  );
}
