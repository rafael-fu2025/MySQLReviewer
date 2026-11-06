# MyLens — UI Design Audit (browser-verified)

**Date:** 2026-10-28
**App:** MyLens 1.1.0 (`MySQLReviewer`), served at `http://127.0.0.1:8787`
**Auditor:** MCode, driving the real app in the in-app Browser
**Backend:** MariaDB 10.4.32 (XAMPP) on `127.0.0.1:3306`
**Account:** `rafael` (admin)

---

## 0. Method

Every screen below was **opened and driven in the real app**, then cross-checked against the
source. Where a claim is about behaviour, the runtime evidence is quoted and the source line is
cited. Where a claim is about a _design_ judgement, the reference guidance it was checked against
is cited in §4.

Screens covered: Connect (signed-out + connected states), Edit-connection modal (both database-scope
states), Database explorer, **Export SQL** modal, **Import SQL** modal, Workspace query editor +
results grid (dark **and** light theme), Settings → Safety (scrolled to the end), Admin → Users,
SQL Lab (empty state).

**Deliberately not done:** no credential was read or typed (the user signed in); no connection,
member or setting was mutated; no export download was completed in the browser; no member
(`sherina` / `gabrielle`) session was exercised. These are listed again in §5.

---

## 1. Findings at a glance

| ID   | Severity     | Area              | Finding                                                             |
| ---- | ------------ | ----------------- | ------------------------------------------------------------------- |
| D-01 | **Critical** | Connection form   | The per-connection write lock is **unreachable in the UI**          |
| D-02 | **Critical** | Results grid      | Every `VARCHAR` column is labelled **VARBINARY**                    |
| D-03 | **High**     | Error surface     | DB errors are stripped of every actionable detail                   |
| D-04 | **High**     | Settings → Safety | The page's primary action is scoped inside one field group          |
| D-05 | **High**     | Settings          | The section tab bar scrolls out of reach                            |
| D-06 | **High**     | App shell         | Scroll position is not reset on route change                        |
| D-07 | **High**     | Import SQL        | No paste path, no drag-and-drop, dead-end first state               |
| D-08 | Medium       | Import/Export     | Sibling modals use inconsistent widths                              |
| D-09 | Medium       | Import SQL        | A destructive-capable action styled like a benign one               |
| D-10 | Medium       | Settings / Admin  | The same switch is labelled positively and negatively               |
| D-11 | Medium       | Connect page      | ~295 px of dead space in the hero card                              |
| D-12 | Medium       | Connect page      | Three competing orange primary buttons                              |
| D-13 | Medium       | Connect page      | "New connection" CTA offered three times                            |
| D-14 | Medium       | Connect page      | File paths are hard-clipped with no ellipsis or tooltip             |
| D-15 | Medium       | SQL Lab           | Empty state leaves ~520 px of dead space below it                   |
| D-16 | Medium       | SQL Lab           | "Generate challenges" offered twice; copy promises an absent picker |
| D-17 | Medium       | Workspace         | The AI assistant FAB overlaps the results grid                      |
| D-18 | Medium       | Results grid      | Rightmost column clipped with no horizontal scroll affordance       |
| D-19 | Low          | Results grid      | Row count and duration are duplicated in two places                 |
| D-20 | Low          | Admin             | The same person appears under two different names                   |
| D-21 | Low          | Database page     | Table-card metadata wraps into orphaned units                       |
| D-22 | Low          | Database page     | Stat tiles have unequal heights between rows                        |
| D-23 | Low          | Connect page      | The "Safety model" card is a five-line paragraph                    |
| D-24 | Low          | Connect page      | One card mixes three unrelated concerns                             |

---

## 2. Critical findings

### D-01 — The per-connection write lock is unreachable in the UI

**What I saw.** Opened _Edit connection_ for Rafael's profile. The form contains: Connection name,
Host, Port, MySQL user, Password, Default database, "Remember password", a **Database access**
panel with `All databases` / `Only selected` badges, "Show socket & SSL options", Cancel / Test /
Save connection.

The DOM contained **no write-access control of any kind**:

```html
<div class="rounded-xl border border-line-soft bg-panel-2 p-3">
  <div class="flex flex-wrap items-center gap-2">
    <div><div class="text-xs font-semibold">Database access</div></div>
    <div class="ml-auto flex gap-1">
      <button class="badge cursor-pointer badge-ember">All databases</button>
      <button class="badge cursor-pointer">Only selected</button>
    </div>
  </div>
</div>
```

**Where it actually lives.** `src/components/ConnectionForm.tsx:411` opens a conditional:

```tsx
{form.databaseScope === 'selected' ? (
  <div className="mt-3 flex flex-col gap-2">
    <MultiSelect ... />                       // :413
    <Checkbox label="Allow server-wide performance and security insights" ... />  // :426
    <Checkbox label="Allow members to write through this connection" ... />       // :434
```

Both permission checkboxes sit **inside** the `databaseScope === 'selected'` branch, alongside the
database picker they have nothing to do with.

**Runtime proof.** Clicking the `Only selected` badge makes both checkboxes appear, fully rendered
and functional, with their helper text:

> ☑ **Allow members to write through this connection**
> Members can unlock writes on this connection for 15 minutes, as they can on any other.

So the control works — it is just unreachable from the default configuration.

**Impact.** A connection created with the default scope (`all`) can **never** be set to
write-locked from the UI. The only two places that display the resulting state —
`src/pages/ConnectPage.tsx:81` and `src/pages/SettingsPage.tsx:441`, both
`<Badge tone="warn">read-only for members</Badge>` — can therefore never show that badge. The
server-side policy in `server/store/users.ts:383-393` is implemented and correct; only the control
surface is missing.

**Fix.** Move the two permission checkboxes out of the database-scope conditional into their own
_Permissions_ section that always renders. The database scope branch should contain only the
`MultiSelect`.

---

### D-02 — Every `VARCHAR` column is labelled `VARBINARY`

**What I saw.** Ran `SELECT CustomerID, CustomerName, ContactName, City, Country FROM customers
ORDER BY CustomerID LIMIT 12;` in the workspace. The results grid header prints a type under each
column name:

```
CustomerID     CustomerName    ContactName    City       Country
INT            VARBINARY       VARBINARY      VARBINARY  …
```

**What the server actually says.**

```
$ mysql -u root -h 127.0.0.1 -N -e "SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_SET_NAME
    FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='northwind' AND TABLE_NAME='customers';"
CustomerID  int      NULL
CustomerName  varchar  utf8
ContactName  varchar  utf8
City          varchar  utf8
Country       varchar  utf8
```

`varchar`/`utf8` — never binary. The `int` label is right; every string label is wrong.

**Root cause.** `server/db/serialize.ts:29`:

```ts
253: 'VARBINARY',
254: 'CHAR',
```

In the MySQL client/server protocol, `enum_field_types` code **253 is `MYSQL_TYPE_VAR_STRING`** —
the type used for `VARCHAR` — and **254 is `MYSQL_TYPE_STRING`**, used for `CHAR`. `VARBINARY`
has **no dedicated protocol code**; a `VARBINARY` column is also reported as 253 and is
distinguished only by the binary charset flag in the column flags. Mapping 253 to `VARBINARY`
therefore mislabels every `VARCHAR` column in the product.

The label reaches the screen through `mysqlTypeName()` (`server/db/serialize.ts:34-36`) →
`server/db/query.ts:166` and `server/db/introspection.ts:870` → `src/components/ResultsGrid.tsx:241`
(`{column.typeName}`).

**Blast radius — display only.** `serializeCell` (`server/db/serialize.ts:51-68`) branches on the
_runtime_ JS type, not on the type code, so the values themselves are correct — the grid shows the
real text, not hex. The damage is that the header lies about the column type, and the type line is
the first thing a user checks when a value looks wrong.

**Why the test suite does not catch it.** `tests/masking.test.ts:14` hardcodes the fixture
`typeName: 'VARBINARY', typeCode: 253`. The test bakes in the very mapping that is wrong, so the
suite stays green while the UI mislabels every string column.

**Fix.**

1. `server/db/serialize.ts:29` → `253: 'VARCHAR'`.
2. For genuine `VARBINARY`, derive the name from the column's binary charset flag (already carried
   as `QueryColumn.flags`; MySQL's `BINARY_FLAG` is `128`) rather than from the type code alone.
3. Update `tests/masking.test.ts:14` to the corrected name so the fixture stops encoding the bug.

---

## 3. High and medium findings

### D-03 — Database errors are stripped of every actionable detail

**What I saw.** A query with a wrong column name produced this in the Messages panel:

```
MYSQL_ERROR
The database rejected the statement.

{ "code": "ER_BAD_FIELD_ERROR" }
```

MariaDB's own message was `Unknown column 'CompanyName' in 'field list'` — exactly the text the
user needs. It was replaced by a generic sentence plus a raw JSON code, which names nothing and
suggests nothing.

**Source.** `server/errors.ts:110-120`:

```ts
if (code.startsWith('ER_')) {
  // The raw MySQL text names internal databases and tables and can
  // repeat a stored column value (ER_DUP_ENTRY). Only the error code is
  // safe to hand back to the client.
  return new AppError('MYSQL_ERROR', 'The database rejected the statement.', 400, { code }, extra);
}
```

The security intent is correct and should be kept — the raw text can leak schema names and stored
values. The defect is that **no recovery path replaces it**. An error state has to answer _what
happened_, _why_, and _what to do next_; this one answers only the first, in the vaguest terms.

**Fix.** Keep the raw server text server-side. Map the common, safe codes to actionable client copy
before returning it — e.g. `ER_BAD_FIELD_ERROR` → "Unknown column. Check the column names against
the schema panel on the left."; `ER_NO_SUCH_TABLE` → "No such table in this database."; `ER_PARSE_ERROR`
→ include the reported line/position. Never echo the raw text for codes that can carry data
(`ER_DUP_ENTRY`, `ER_DATA_TOO_LONG` and friends stay generic).

### D-04 — The settings page's primary action is scoped inside one field group

`Save safety settings` sits at the bottom-right **inside the QUERY LIMITS card**
(`src/pages/SettingsPage.tsx:784-793`, the `<Button>` closes at `:791` and the enclosing `</Card>`
at `:793`). It saves the whole tab — write unlocking, masking and query limits — so its placement
implies it belongs to the four limit fields.

**Fix.** Move it into a page-level action row (ideally a sticky footer above the status bar) that
is visually separate from the QUERY LIMITS group.

### D-05 — The Settings section tab bar scrolls out of reach

On the Safety tab the `Settings` H1 and the tab strip (`Connections · AI providers · Review ·
Safety · Appearance · Data & about`) scroll away with the content. A long tab therefore loses the
only control for switching sections.

**Fix.** Make the H1 + tab strip a sticky header of the scroll container.

### D-06 — Scroll position is not reset on route change

Measured, not inferred. On `/settings` the content pane was scrolled to 92 px. Navigating to
`/admin` left the new page scrolled to **92 px** — the `Admin` H1 and its subtitle
_"Signed in as Rafael (admin). Sandboxes give members a private copy of a database."_ were cut off
above the fold. Scrolling up by exactly 92 px (`actualDeltaY: -92`, `atStart: true`) brought the
heading back.

**Fix.** Reset the scroll container's `scrollTop` on pathname change.

### D-07 — Import SQL has no paste path, no drag-and-drop, and a dead-end first state

`src/components/ImportSqlModal.tsx` contains only a file input (`accept=".sql"`, line 215). There
is no `<textarea>`, no paste handler and no `onDrop` — the API accepts a raw `sql` string, so
pasted SQL is a supported path that the UI does not offer.

The modal's opening state is a dead end:

```
Import SQL
Runs against northwind

[Choose .sql file]   No file chosen yet.
                                  [Cancel]
```

The body contains one control; the footer contains only _Cancel_. Nothing states what will happen
on import (statements are parsed, classified and reviewed before anything runs), nothing states the
accepted format, and the only action in the body is not styled as the primary action of the modal.

**Fix.** Add a paste area beside the file picker; make the file button the primary action; add one
line explaining the review-then-run flow and that destructive statements are flagged.

### D-08 — Sibling modals use inconsistent widths

The Export modal is ~600 px wide; the Import modal is ~880 px (`src/components/ImportSqlModal.tsx:188`,
`size="wide"`) for a single row of content. Two sibling features on the same screen should share a
width rule.

### D-09 — A destructive-capable action is styled like a benign one

`Export SQL` and `Import SQL` are both `btn-secondary` (`src/pages/DatabasePage.tsx`), adjacent to
the orange `Create database`. Import can drop or truncate data — the modal even detects it and
warns (`ImportSqlModal.tsx:260`) — so it should not carry the same weight as a read-only export.

### D-10 — The same switch is labelled positively and negatively on two screens

- Settings → Safety → WRITE UNLOCKING: **"Allow write unlocking"** (positive, ON).
- Admin → Users → WRITE ACCESS: **"Block write unlocking"** (negative, OFF).

Same control, opposite framing, on two screens the same admin uses together. Negative-polarity
labels make the ON state ambiguous ("is blocking on, or is blocking off?"). The Admin page also
shows the control for the admin account, where the copy — _"This account can unlock writes for its
own connection for 15 minutes."_ — describes a member's grant, not an admin's
profile-wide one.

**Fix.** Use positive polarity everywhere ("Allow write unlocking"), and tailor the help text per role.

### D-11 — ~295 px of dead space in the Connect page hero

The "Connect to your MySQL server" card holds a heading, one line of copy and two buttons, then
runs to the card's bottom edge with roughly 295 px of empty space below them (card bottom at
y≈545, buttons end at y≈241).

### D-12 — Three competing orange primary buttons on the Connect page

`New connection` (hero), `Open workspace` (Connected panel) and `Reconnect` (Rafael's card) are
all `btn-primary` orange. On a page whose job is "pick a connection and go", only one of these
should carry primary emphasis.

### D-13 — "New connection" is offered three times

The hero button, the `Connections` section-header button, and a 170 px dashed tile rendered as
another grid item. Two of the three are redundant, and the dashed tile consumes a full grid cell.

### D-14 — File paths are hard-clipped with no ellipsis or tooltip

In the "This machine" card, `C:\Users\udtoh_lmtzs7k\MySQL-` is cut mid-path at the panel edge with
no ellipsis and no way to read the rest.

### D-15 / D-16 — SQL Lab empty state

The empty state itself is **exemplary** — target icon in a rounded square, headline
_"No challenge set yet"_, description _"Choose tables and topics, then generate a set."_, and a
primary `Generate challenges` button. That is exactly the NN/g + Carbon shape (icon → headline →
description → primary action) and is worth keeping as the house pattern.

Two problems around it:

- The block sits at the top of the viewport leaving ~520 px of blank page beneath it, instead of
  being centred in the available space.
- `Generate challenges` appears twice — once in the page header and once as the empty-state primary
  action. The copy also promises "Choose tables and topics" but no tables/topics picker is on
  screen, so the instruction refers to a step the user cannot perform.

### D-17 — The AI assistant FAB overlaps the results grid

The orange assistant button sits bottom-right over the results table and covers the last visible
rows (confirmed in both themes — over the `Ernst Handel` row). The workspace already has a
status bar along the bottom edge; the FAB lands in the same band as scrollable data.

**Fix.** Offset the FAB above the status bar, and hide or shift it while the results panel has
focus.

### D-18 — Rightmost column clipped with no horizontal scroll affordance

With five columns the `Country` column is cut mid-word at the pane edge (`Co…` / `G…`). Only a
vertical scrollbar is visible on the pane. A SQL result grid with no horizontal scroll indication
looks like data loss rather than overflow.

### D-19 — Row count and duration duplicated

`20 ms · 12 rows` appears in the results tab strip _and_ `12 rows · 20 ms` in the toolbar
immediately below it.

### D-20 — The same person appears under two names in Admin

One card shows the account as `sherina` (username, no display name) and its sandbox chip as
`Sherina`; the next shows `Gab` (display name) with username `gabrielle` and chip `Gabrielle`.
Two accounts use display names, one does not, so the list is inconsistent.

### D-21 — Table-card metadata wraps into orphaned units

On the Database page, `InnoDB · 8 rows · 16.0 KB` wraps so that `16.0` and `KB` split across
lines, and `InnoDB · 830 rows ·` leaves a trailing `·` at the end of a line.

### D-22 — Stat tiles have unequal heights between rows

The `TABLES / VIEWS / ROUTINES` row and the `TRIGGERS / EVENTS / TOTAL SIZE` row have different
heights, because `TOTAL SIZE` carries a second line (`data + indexes`) and stretches its row.

### D-23 / D-24 — Connect page information architecture

The "Safety model" card is a five-line prose paragraph; the same card also holds machine metadata
above it and connection state below it. Three unrelated concerns share one panel with no hierarchy.

---

## 4. References used

| Area                 | Reference                                                                                                                                                                                                                                                                                                                                                                                                                               |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Empty states         | [NN/g via Kate Kaplan](https://www.mocmallen.com/blog/designing-the-empty-state) — "explain the container", "show the first action"; [Carbon Design System empty states](https://carbondesignsystem.com/components/empty-states/usage/) — "clear explanation of next actions", "do not lead users into dead ends"; [Material empty states](https://m3.material.io/components/empty-states/guidelines) — non-interactive image + tagline |
| Feedback & errors    | [UI/UX Atlas — Heuristic #1](https://uiuxatlas.com/lessons/interaction-design/feedback-and-system-status/) — every state transition needs feedback; error states need _what / why / what-next_; destructive actions pair with undo                                                                                                                                                                                                      |
| Destructive actions  | [destructive-action-ux](https://github.com/aladicf/better-web-ui/blob/main/skills/frontend-design/reference/destructive-action-ux.md) — dedicated review step for bulk/destructive operations; confirmation copy must name scope and consequence                                                                                                                                                                                        |
| Dark mode & contrast | [Dark Mode Dashboard Patterns](https://artofstyleframe.com/blog/dashboard-dark-mode-design-patterns/) — elevation via surface lightness, WCAG 2.2 4.5:1 body / 3:1 UI, never colour alone (SC 1.4.1)                                                                                                                                                                                                                                    |
| Admin dashboards     | [Admin Dashboard Design (2026)](https://adminlte.io/blog/admin-dashboard-design/) — cap top-level nav and KPI tiles near 5–7; dark mode is a redesign of the contrast math, not an inverted skin                                                                                                                                                                                                                                        |
| Light/dark a11y      | [Light/Dark Mode Accessibility Best Practices](https://github.com/mgifford/ACCESSIBILITY.md/blob/main/examples/LIGHT_DARK_MODE_ACCESSIBILITY_BEST_PRACTICES.md) — focus indicators visible in every mode; test actual colour combinations                                                                                                                                                                                               |
| SQL client UX        | [MySQL Workbench Visual SQL Editor](https://dev.mysql.com/doc/workbench/en/wb-sql-editor.html), [Jamf SQL Query Editor](https://jamsql.com/docs/query-editor/), [Microsoft Fabric SQL query editor](https://learn.microsoft.com/en-us/fabric/data-warehouse/sql-query-editor) — object tree + editor + output area as three panels; column type shown under the column name                                                             |

---

## 5. What was **not** verified

- The Export SQL download was not completed in the browser (a download would have opened a save
  flow). The export **API** path is covered by `scripts/audit/verify-import-export.ps1`; the
  **modal** was opened and read.
- The Import SQL flow was not exercised with a real `.sql` file in the browser; the modal was
  opened and its first state read. The import API path is covered by the same harness.
- No member session (`sherina`, `gabrielle`) was opened, so member-facing views — the sandbox
  picker, the "read-only for members" badge as a member sees it, and the write-unlock dialog — are
  **unverified in the UI**.
- No viewport narrower than the 1084 × 899 Browser panel was tested; the dead-space findings
  (D-11, D-15) would change on a laptop-height window.
- Only MariaDB 10.4.32 was used. The D-02 type-code table is the MySQL client/server protocol's
  and is shared with Oracle MySQL, but no Oracle MySQL server was available here.
- Focus-ring visibility, screen-reader announcement and keyboard-only traversal were not audited
  with assistive technology; only the ARIA semantics visible in the DOM were checked.
- The uninvited AI assistant feature (`server/ai/assistant.ts`, `src/components/AiAssistant.tsx`,
  `src/components/assistant/`) was **not** reviewed — it is outside the requested scope and the
  user has not signed off on it. Its floating button is only noted as an overlap (D-17).

---

## 6. Suggested fix order

1. **D-01** — move the permission checkboxes out of the database-scope branch. Small, and it
   unblocks a whole feature.
2. **D-02** — one-line mapping fix plus a fixture correction; add a regression test asserting a
   `varchar` column renders as `VARCHAR`.
3. **D-03** — safe error-code → copy mapping table, with a test per mapped code.
4. **D-06**, **D-05**, **D-04** — scroll reset, sticky tab strip, page-level save action.
5. **D-07**, **D-08**, **D-09** — rework the import modal: paste area, primary action, consistent
   width, distinct visual weight.
6. **D-10** – **D-18** — polish sweep.
7. **D-19** – **D-24** — copy, spacing and consistency sweep.

Each fix should carry a regression test that fails before it and passes after, per the standing
remediation rule for this project.
