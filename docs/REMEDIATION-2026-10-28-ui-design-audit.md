# MyLens — UI Design Audit Remediation

**Date:** 2026-10-28
**Scope:** all 24 findings (D-01 … D-24) from `docs/AUDIT-2026-10-28-ui-design-audit.md`
**Method:** fix → regression test that fails before and passes after → rebuild → re-verify in the browser
**Tree state:** intentionally **uncommitted**. Nothing was staged and no branch was created.

---

## 0. Summary

| Severity | Findings | Fixed | Verified in the running app |
| -------- | -------- | ----- | --------------------------- |
| Critical | 2        | 2     | 2                           |
| High     | 5        | 5     | 5                           |
| Medium   | 12       | 12    | 12                          |
| Low      | 5        | 5     | 3 (2 measured only)         |

**Gates:** `npm run typecheck` → 0 · `npm run lint` (`eslint . --max-warnings 0`) → 0 · `npm run build` → 0 ·
`npm test` → **50 files / 530 tests, all passing** · the five API harnesses in `scripts/audit/` → **87/87**.

**New tests:** 12 new test files, 80 new assertions across the round (the suite grew from 38 files /
449 tests to 50 files / 530 tests).

---

## 1. The two Critical findings

### D-01 — The per-connection write lock was unreachable in the UI

**Cause.** `src/components/ConnectionForm.tsx:411` opened a conditional that swallowed both permission
checkboxes:

```tsx
{form.databaseScope === 'selected' ? (
  <div className="mt-3 flex flex-col gap-2">
    <MultiSelect ... />                              {/* the database picker */}
    <Checkbox label="Allow server-wide performance and security insights" ... />
    <Checkbox label="Allow members to write through this connection" ... />
```

Connections default to `databaseScope: 'all'`, so the branch never rendered. The control existed in the
source and in the unit tests, and was absent from the app.

**Fix.** The checkboxes moved out of the scope branch into their own **Permissions** card, a sibling of the
**Database access** card. Two related corrections came with it:

- The insights control is now _derived_, not stored twice:
  `serverWideInsights = form.databaseScope === 'all' && form.allowServerWideInsights`. Switching the
  database scope no longer silently rewrites a permission flag — it used to force
  `allowServerWideInsights` to `true`/`false` behind the user's back.
- The insights checkbox is **disabled with an explanation** while the scope is narrowed, instead of
  vanishing. The server relies on that invariant (`server/db/scope.ts:79` only refuses server-wide
  insights when the mode is `selected` _and_ the flag is off), so the UI now states the rule rather than
  hiding the control.

**Regression test.** `tests/ui-connection-permissions.test.tsx` — 5 assertions.
_Before:_ 4 failed, 1 passed (`expected … to contain 'Allow members to write through this connection'`
→ not found).
_After:_ 5/5 pass.

**Browser re-check.** Edit connection, default `All databases` scope → the Permissions card renders with
both controls enabled. Confirmed in the rebuilt app.

### D-02 — Every VARCHAR column was labelled VARBINARY

**Cause.** `server/db/serialize.ts:29` mapped protocol code `253` to `'VARBINARY'`. In the MySQL
client/server protocol, **253 is `MYSQL_TYPE_VAR_STRING`** — the code the server reports for `VARCHAR` —
and 254 is `MYSQL_TYPE_STRING` (CHAR). `VARBINARY` has no dedicated code: a `VARBINARY` column is also
reported as 253 and is distinguished only by the binary charset flag.

**Fix.**

- `server/db/serialize.ts` → `253: 'VARCHAR'`, and `mysqlTypeName(code, flags)` now returns `VARBINARY`
  only when the column carries MySQL's `BINARY_FLAG` (128).
- `server/db/query.ts:166` and `server/db/introspection.ts:870` pass the column flags through.
- `tests/masking.test.ts:14` — the fixture had hardcoded `typeName: 'VARBINARY', typeCode: 253`, i.e. it
  encoded the bug. Corrected to `VARCHAR`, otherwise the suite would have stayed green while the UI
  mislabelled every string column.

**Regression test.** `tests/ui-type-labels.test.ts` — 5 assertions (253 → VARCHAR, 253 + BINARY_FLAG →
VARBINARY, 254 → CHAR, integers, unknown code).

**Browser re-check.** `SELECT CustomerID, CustomerName, ContactName, City, Country FROM customers` now
renders `INT · VARCHAR · VARCHAR · VARCHAR · VARCHAR`. Before: `INT · VARBINARY · VARBINARY · …`.

---

## 2. High and Medium findings

### D-03 — Database errors lost every actionable detail

`server/errors.ts` dropped the raw MySQL text for every `ER_*` code and returned _"The database rejected
the statement."_ plus the raw code. The security intent was right — the raw text names internal tables and
can repeat a stored value — but the user was left with nothing to act on.

**Fix.** A `SAFE_ERROR_COPY` table maps the common codes to actionable copy while the raw text stays on
the server: `ER_BAD_FIELD_ERROR` → `UNKNOWN_COLUMN` / _"Unknown column. Check the column names against the
schema panel on the left."_; plus `ER_DUP_ENTRY`, `ER_DATA_TOO_LONG`, `ER_NO_REFERENCED_ROW*`,
`ER_ROW_IS_REFERENCED*`, `ER_LOCK_DEADLOCK`, `ER_LOCK_WAIT_TIMEOUT`, `ER_TOO_MANY_USER_CONNECTIONS`,
`ER_OUT_OF_RANGE`, `ER_SP_DOES_NOT_EXIST`, `ER_SP_WRONG_NO_OF_ARGS`, `ER_SIGNAL_EXCEPTION`,
`ER_QUERY_TIMEOUT` and others. Unmapped codes keep the generic message. `details` still carries the
MySQL code for support.

**Regression test.** `tests/ui-error-copy.test.ts` — 8 assertions, including that the copy never echoes
the server text. The existing F-22 test in `tests/crypto.test.ts` was updated to keep its security
assertions (`not.toContain('stored-secret-value')`, `not.toContain('users')`) and to assert the new
behaviour; it still fails if the raw text leaks.

**Browser re-check.** A query with a bad column now shows
`UNKNOWN_COLUMN — Unknown column. Check the column names against the schema panel on the left.`
with `{ "code": "ER_BAD_FIELD_ERROR" }` kept underneath.

### D-04 — The Safety page's primary action was scoped inside one field group

`Save safety settings` was the last child of the QUERY LIMITS card (`src/pages/SettingsPage.tsx:784-793`)
although it saves the whole tab. Moved into a page-level action row below the last card.

### D-05 — The Settings section switcher scrolled out of reach

The H1 and the tab strip scrolled away with the content. Both now live in a sticky header
(`src/pages/SettingsPage.tsx:137`).

**The first attempt was wrong, and the browser caught it.** The header was given a negative top margin
(`-mt-6`) to cover the scroll container's padding. A sticky element is constrained by its **containing
block's padding box**, and the header's containing block is `.page`, which starts _below_ the scroll
container's 24 px top padding. So the header can never rise higher than that padding line, and the
negative margin pushed its painted box _further down_ — the strip of scrolling content above the header
grew from 24 px to 48 px.

**The fix** keeps the header's own box where the layout wants it and paints the strip instead: a
`::before` band (`before:absolute before:inset-x-0 before:-top-6 before:h-6 before:bg-canvas`, with a
12 px variant at ≤640 px) extends the header's background up over the gap. Measured in the browser after
the change: the "Settings" heading and the tab strip stay pinned and **no content shows above them**.

### D-06 — Scroll position was not reset on a route change

Measured before the fix: leaving Settings 92 px down and opening Admin put the Admin heading above the
fold.

**Fix.** `src/lib/scroll.ts` (new) exports `resetScrollTop`; `src/components/AppShell.tsx` resets **both**
scroll containers on every pathname change — the page body (`.content`, `overflow:auto`, the container the
wheel actually scrolls) and the shell frame (`main`).

> A note on how this was found: the first implementation reset `main` only. Measuring again showed the
> real scroller is `.content` (`src/styles/shell.css`), which is what the wheel scrolls and what carries
> the offset across routes. Both are reset now, and the browser re-check was repeated with a real 397 px
> wheel scroll.

**Regression test.** `tests/ui-route-scroll.test.ts` — 3 assertions on the helper.

### D-07 / D-08 — The Import SQL modal was a dead end

- A **paste area** (`Or paste SQL`) now sits beside the file picker; pasted SQL goes through the same
  review path as a file.
- The file picker is the **primary** button; the modal states _"Statements are parsed and shown for
  review. Nothing runs until you press Run."_
- The modal uses the **default width**, matching the Export modal (`src/components/ImportSqlModal.tsx:188`).
- The source block was extracted into an exported `ImportSqlSource` component so it can be rendered on its
  own.

**Regression test.** `tests/ui-import-modal.test.tsx` — 6 assertions.

### D-09 — Import SQL was styled like a benign export

On the Database page the import action now sits in its own warn-toned group with the note
**"can modify data"**; `Export SQL` stays a plain secondary button and `Create database` remains the only
primary action.

### D-10 — The same switch was labelled positively on one screen and negatively on another

Admin's per-account control was _"Block write unlocking"_ (negative) while Settings said _"Allow write
unlocking"_. Both now read **"Allow write unlocking"**, and the switch reads positive: on = writes can be
unlocked. The admin's help text was rewritten to match the real policy in
`server/store/users.ts:364-408` — an admin holds a **profile-wide** grant, and a connection-level lock
never applies to an admin; the per-account lock does.

### D-11 … D-16 — Connect page and SQL Lab

- **D-11** the hero card sizes to its content instead of stretching ~295 px down the panel.
- **D-12** exactly one primary button on the page ("Open workspace" when connected, otherwise the connect
  action of one profile); "New connection" is secondary.
- **D-13** the 170 px dashed "New connection" tile is gone from the connection grid; the action is offered
  twice (hero + section header) rather than three times.
- **D-14** long paths truncate with an ellipsis **and** carry the full value in a `title`, so nothing is
  silently cut.
- **D-15** the SQL Lab empty state is a direct child of the page and is now vertically centred (measured
  in headless Chrome: 346 px above, 310 px below, instead of 92 px with 564 px of dead space).
- **D-16** "Generate challenges" appears once, and the copy no longer promises a step the screen cannot
  perform (_"Open the setup panel to choose tables, topics, and difficulty, then generate a set."_).

### D-17 / D-18 / D-19 — Workspace results

- **D-17** the assistant button is lifted clear of the status bar (`--ai-fab-bottom + 26px`) and the output
  pane reserves the band it covers, so it no longer sits on top of result rows.
- **D-18** the grid is a real scroll region (`overflow-x-auto overflow-y-auto`) with the table at
  `min-w-max`, so a wide result set scrolls sideways instead of being squeezed until the last column is
  cut mid-word.
- **D-19** the row count and duration are shown once, in the grid's own toolbar (which `DatabasePage` and
  `PracticePage` also use); the output strip no longer repeats them.

### D-20 — One person appeared under two names in Admin

One canonical display name per account (`accountName()`), the username shown once as secondary metadata
(`@rafael · created …`), and the sandbox chip now names the **connection** (`Connection · Sherina`) so it
cannot read as a second name for the person `sherina`.

### D-21 / D-22 / D-23 / D-24 — Database page and Connect page polish

- **D-21** the metadata separator is bound forward (`·` + non-breaking space) and the units are non-breaking,
  so `16.0 KB` never splits and a separator can never end a line.
- **D-22** the two stat-tile rows are the same height (`auto-rows-[1fr]` — note Tailwind v4 renamed the
  utility; `grid-auto-rows-*` is v3 and is silently not generated, which the first attempt used).
- **D-23** the safety model is four short bullets instead of a five-line paragraph.
- **D-24** machine facts, the safety model and the connection status are three separate cards.

---

## 3. How the tests were written

There is no `jsdom` and no `@testing-library/react` in this repo, and none was added. The house pattern
already used by `tests/import-export-ui.test.ts` is to extract the decision into a pure function and test
that. For the UI findings the same idea was applied with **`react-dom/server`**:

```tsx
const html = renderToStaticMarkup(<ConnectionForm profile={profile} onSaved={() => {}} />);
expect(html).toContain('Allow members to write through this connection');
```

`vitest.config.ts` was extended by one line to also collect `tests/**/*.test.tsx`
(`include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx']`). `environment` stays `node`.

Where a page reads the app store and therefore cannot be rendered, the presentational part was extracted
into a small component in the same file with plain props, and the test renders that.

Every finding was written **test-first**: the test was run against the unfixed code and observed to fail,
and only then was the fix applied. The workers who handled the Medium/Low batch repeated the same loop
with the final test file against temporarily reverted source, so the quoted "before" failures are real
observations, not reconstructions.

---

## 4. Known limits of the fixes

| Limit                                                                                                                          | Why                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D-22's test asserts the mechanism (`auto-rows-[1fr]`), not pixel equality                                                      | Vitest has no layout engine. The equal-row proof is a headless-Chrome measurement: tile rows went from `[80, 80, 80, 93, 93, 93]` to `[93, 93, 93, 93, 93, 93]`                  |
| D-05's sticky header was measured by reading the built CSS and by scrolling in the browser, not by asserting a computed offset | No layout engine in the test                                                                                                                                                     |
| D-09's warning tone sits on a wrapper element, not on the button                                                               | The shared `.btn-secondary` rule is unlayered CSS and cannot be recoloured by a Tailwind utility from a call site; changing it would mean editing `src/components/ui/button.tsx` |
| D-21 can now wrap a metadata line so that it _starts_ with `·`                                                                 | Binding the separator forward is the only way to guarantee it never _ends_ a line                                                                                                |
| D-06 resets two containers rather than one                                                                                     | The shell has two scroll containers and either could carry the offset                                                                                                            |
| The phone layout was never measured                                                                                            | The audit ran at one viewport; the FAB's reserved band on the phone layout is derived from the CSS, not observed                                                                 |

**Theme coverage.** Every colour introduced by this round is a design token, not a literal: the D-09 warning
group uses `--color-warn`, which `src/styles/tokens.css` defines for both themes (`#f5b544` dark,
`#885b0c` light). The D-17 FAB offset follows `--ai-fab-bottom`, so it moves with the phone layout's bottom
navigation rather than being pinned to a desktop coordinate.

**Two items outside my control were left undone and are reported rather than worked around:**

1. The uninvited AI assistant (`server/ai/assistant.ts`, `src/components/AiAssistant.tsx`,
   `src/components/assistant/`) is still there. Only its button offsets were adjusted (D-17); nothing was
   built for it and nothing was removed — that decision is the user's.
2. Throwaway scratch directories were left behind under `%TEMP%` by the workers and by the measurement
   script (`mylens-before`, `mylens-layout-check`, `mylens-verify-*`, `mylens-verify-measure`). The
   local recoverable-delete refuses targets **outside the workspace**, so they could not be trashed, and
   they were not removed by any other means. They are outside the repository and harmless, but they are
   still on disk.

---

## 5. File map

**Changed by the reviewer**

| File                                                                         | Finding    |
| ---------------------------------------------------------------------------- | ---------- |
| `src/components/ConnectionForm.tsx`                                          | D-01       |
| `server/db/serialize.ts`, `server/db/query.ts`, `server/db/introspection.ts` | D-02       |
| `server/errors.ts`                                                           | D-03       |
| `src/lib/scroll.ts` (new), `src/components/AppShell.tsx`                     | D-06       |
| `src/components/ImportSqlModal.tsx`                                          | D-07, D-08 |

**Changed by the remediation workers**

| File                                                                                              | Finding                                   |
| ------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `src/pages/SettingsPage.tsx`                                                                      | D-04, D-05                                |
| `src/pages/AdminPage.tsx`                                                                         | D-10, D-20                                |
| `src/pages/ConnectPage.tsx`                                                                       | D-11, D-12, D-13, D-14, D-23, D-24        |
| `src/pages/DatabasePage.tsx`                                                                      | D-09, D-21, D-22                          |
| `src/pages/PracticePage.tsx`                                                                      | D-15, D-16                                |
| `src/components/ResultsGrid.tsx`, `src/components/AiAssistant.tsx`, `src/pages/WorkspacePage.tsx` | D-17, D-18, D-19                          |
| `src/styles/features/editor.css`                                                                  | removed the now-unused `.table-wrap` rule |

**Tests added**

`tests/ui-type-labels.test.ts` · `tests/ui-error-copy.test.ts` · `tests/ui-connection-permissions.test.tsx` ·
`tests/ui-route-scroll.test.ts` · `tests/ui-import-modal.test.tsx` · `tests/ui-safety-settings.test.tsx` ·
`tests/ui-admin-page.test.tsx` · `tests/ui-connect-page.test.tsx` · `tests/ui-database-page.test.tsx` ·
`tests/ui-practice-page.test.tsx` · `tests/ui-results-grid.test.tsx` · `tests/ui-workspace.test.tsx`

**Also changed:** `vitest.config.ts` (collect `.tsx` tests) · `tests/crypto.test.ts` (the F-22 test now
asserts the new actionable copy while keeping its no-leak assertions).

---

## 6. Independent verification

An independent adversarial verifier was dispatched to re-run the original proof steps against the
rebuilt app rather than the new unit tests. **It was cut off part-way through by its own BYOK model
provider** (`custom_provider:9router` returned `503 Token Plan usage limit reached`), so it never
produced a report. Its trace shows it had already:

- confirmed **D-01** ("D-01 checks out") — the write-lock control is present, persists through
  `PUT /api/connections/:id`, shows the "read-only for members" badge, and is enforced server-side for a
  member (state restored afterwards);
- run the D-02 type-labelling probe against the live server, the D-03 error probe (on a scratch
  database, dropped afterwards), and the D-04/D-05/D-06 measurements;
- redone the FAB-overlap and horizontal-scrollbar tests rigorously, with scrollbars _not_ hidden.

Because the sub-agent provider was out of budget, the remaining measurements were completed with a
throwaway headless-Chrome/CDP script of my own (in `%TEMP%`, not in the repository), driving the real
app at 1440×900:

| Finding | Measurement                                                                                                                                                        |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D-17    | the assistant button's rectangle intersects **0 of 2** result rows; it sits 42 px above the viewport bottom                                                        |
| D-18    | the grid's scroll region is `min-h-0 flex-1 overflow-x-auto overflow-y-auto` with the table at `min-w-max` — a wide set scrolls sideways instead of being squeezed |
| D-19    | the pair "1 rows · 61 ms" occurs **exactly once** in the page text                                                                                                 |
| D-12    | the Connect page has **1** `.btn-primary` ("Open workspace")                                                                                                       |
| D-13    | **0** dashed tiles; "New connection" appears **2** times (hero + section header), not 3                                                                            |
| D-11    | the hero card is 710 px tall with its content ending 57 px above the card's bottom — i.e. it is card padding, not the ~295 px of void the audit measured           |
| D-15    | the SQL Lab empty state has 226 px above and 202 px below → centred                                                                                                |
| D-16    | "Generate challenges" is the **only** primary button                                                                                                               |
| D-06    | after a route change the content's `scrollTop` is **0** and the new page's heading sits 24 px inside the content — at the top                                      |

Two measurements the script could not make cleanly (the stat-tile row heights and the table-card
metadata wrapping) were already measured independently in headless Chrome by the worker that fixed
them: tile rows went from `[80, 80, 80, 93, 93, 93]` to `[93, 93, 93, 93, 93, 93]`, and the metadata
went from `["InnoDB · 830 rows · 16.0 ", "KB"]` to `["InnoDB · 830 rows", "· 16.0 KB"]` with no line
ending in a separator. Both were also confirmed visually in the running app.
