import { useCallback, useEffect, useMemo, useState } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { MySQL, sql } from '@codemirror/lang-sql';
import {
  snippetCompletion,
  type Completion,
  type CompletionContext,
  type CompletionSource,
} from '@codemirror/autocomplete';
import { EditorState, Prec } from '@codemirror/state';
import { EditorView, hoverTooltip, keymap } from '@codemirror/view';
import { lintGutter, linter, type Diagnostic } from '@codemirror/lint';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import type { SchemaSummary, Snippet, StaticReviewResult } from '@shared/types';
import { api } from '@/lib/api';
import { findingRange } from '@/lib/finding-range';
import {
  SQL_SNIPPET_TEMPLATES,
  buildHoverIndex,
  qualifierBefore,
  resolveHover,
  savedSnippetCompletions,
} from '@/lib/sql-snippets';

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
    '.cm-sql-hover': {
      padding: '6px 9px',
      fontSize: '11px',
      fontWeight: '560',
      lineHeight: '1.35',
      letterSpacing: '0.01em',
    },
    '.cm-sql-hover-title': {
      fontFamily: 'var(--font-mono, monospace)',
      fontWeight: '700',
      color: 'var(--color-ink)',
    },
    '.cm-sql-hover-line': {
      marginTop: '2px',
      color: 'var(--color-muted)',
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
// The template set never changes, so its snippet completions are built once.
const templateCompletions: Completion[] = SQL_SNIPPET_TEMPLATES.map((template) =>
  snippetCompletion(template.body, {
    label: template.label,
    detail: template.detail,
    type: 'text',
  }),
);

export function SqlEditor({
  value,
  onChange,
  schema,
  snippets = [],
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
  /** Saved snippets, offered as completions alongside the built-in templates. */
  snippets?: Snippet[];
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
    // The source merges with the language's own keyword and schema sources by
    // joining the same language-data facet `sql()` registers its sources on.
    // Saved snippets are inserted verbatim (`apply` is plain text), so
    // prepared-statement `${}` markers and PLACEHOLDER tokens stay untouched.
    const snippetOptions: Completion[] = [
      ...templateCompletions,
      ...savedSnippetCompletions(snippets),
    ];
    const completionSource: CompletionSource = (context: CompletionContext) => {
      // Snippets only compete while an identifier is being typed; after a dot
      // (column completion) or on whitespace the language's own sources run
      // alone.
      const word = context.matchBefore(/[\w$]+/);
      if (!word) return null;
      return { from: word.from, options: snippetOptions };
    };
    return [
      sql({
        dialect: MySQL,
        schema: schemaObject,
        upperCaseKeywords: true,
      }),
      MySQL.language.data.of({ autocomplete: completionSource }),
    ];
  }, [schema, snippets]);

  // Hover facts are rebuilt only when the schema changes; the tooltip source
  // reads through the closed-over index, so hovering stays cheap.
  const hoverExtension = useMemo(() => {
    const hoverIndex = buildHoverIndex(schema?.tables ?? []);
    return hoverTooltip(
      (view, pos) => {
        const line = view.state.doc.lineAt(pos);
        const word = view.state.wordAt(pos);
        if (!word) return null;
        const wordText = line.text.slice(word.from - line.from, word.to - line.from);
        const qualifier = qualifierBefore(line.text, word.from - line.from);
        const info = resolveHover(wordText, qualifier, hoverIndex);
        if (!info) return null;
        return {
          pos: word.from,
          above: true,
          create: () => {
            const dom = document.createElement('div');
            dom.className = 'cm-sql-hover';
            const title = dom.appendChild(document.createElement('div'));
            title.className = 'cm-sql-hover-title';
            title.textContent = info.title;
            for (const infoLine of info.lines) {
              const row = dom.appendChild(document.createElement('div'));
              row.className = 'cm-sql-hover-line';
              row.textContent = infoLine;
            }
            return { dom };
          },
        };
      },
      // Hover-only: touch taps never open it, so mobile behavior is unchanged.
      { hoverTime: 300 },
    );
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
              const { from, to } = findingRange(
                finding.column,
                line,
                view.state.sliceDoc(line.from, line.to),
              );
              diagnostics.push({
                from,
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
      hoverExtension,
      highlightExtension,
      tabSizeExtension,
      ...lintExtensions,
      keymapExtension,
    ],
    [hoverExtension, keymapExtension, lintExtensions, sqlExtension],
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
      placeholder="-- Write SQL here"
    />
  );
}
