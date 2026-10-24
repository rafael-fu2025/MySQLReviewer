# UI copy & noise audit (AI-slop patterns)

**Date:** 2026-10-24
**Scope:** all user-visible copy and micro-UX across the ten routes, shared components, and the server-side strings that reach the user (AI prompts, parse fallbacks, report exports, error messages).
**Companion to:** `docs/ui-audit.md` (visual/layout audit — separate scope, already applied).
**Method:** full read of every page and component, plus a survey of `server/` string templates. Every finding below was verified against the working tree (line numbers are from the current uncommitted state).

---

## Verdict

The app is clean of the classic AI-slop markers: **zero emoji** in `src/` or `server/`, no marketing phrases ("seamless", "effortless", "dive into", "unlock the power"), no cutesy loading text, no `console.log` in UI paths, and the AI prompts themselves are explicitly anti-slop ("Never give generic advice that could apply to any query"). The deterministic rule text is specific and imperative throughout.

What remains is ~150 findings in **six systemic patterns** — all of them cheap to fix, and roughly 40 are pure deletions:

1. **Copy that restates adjacent UI** — empty-state paragraphs repeating the title, tooltips repeating the label, toggle descriptions repeating the toggle name (~35).
2. **The same fact narrated 2–4× per screen or flow** — disclaimers, counts, warnings, privacy claims (~30).
3. **Terminology drift** — the same action or object named 3–5 different ways across screens (~15 axes).
4. **Parallel-triad cadence** — "A, B, and C" lists in captions, subtitles, and confirm copy; the classic AI rhythm (~15).
5. **Reassurance and lecture voice** — "encrypted at rest" ×4 in one flow, "on this machine" ×5, "Nicely done.", "topic mastery" (~20).
6. **Genuine defects** — mislabeled data, double-rendered labels, unconditional callouts, filler AI fallbacks (~10).

---

## P1 — Copy restating adjacent UI (delete the second surface)

Empty states whose paragraph repeats the title:

- `DatabasePage.tsx:88` — "No relationships" + "This table has no foreign keys pointing in or out." → delete copy
- `DatabasePage.tsx:775` — "No indexes" + "This table has no index definitions." → delete copy
- `DatabasePage.tsx:908` — "No triggers" + "No triggers are attached to this table." → delete copy
- `ResultsGrid.tsx:247` — "Query returned no rows" + "The statement succeeded, but the result set is empty." → delete copy; title → "No rows returned"
- `Findings.tsx:266` — "No findings" + "This audit did not produce any findings." → delete copy
- `WorkspacePage.tsx:147` — a Warnings panel empty message for a section that isn't rendered → delete block (145-149)

Tooltips/hints restating the visible label:

- `SchemaSidebar.tsx:363` — `title="Preview 5 rows of X"` beside a "Preview 5 rows" button → drop title (also hardcodes the count)
- `SchemaSidebar.tsx:394` — `title="Insert X · click the arrow to open details"` → "Insert X"
- `PracticePage.tsx:870` — tooltip "Generate another challenge set" on button "New challenges" → delete
- `PerformancePage.tsx:520` — tooltip "Kill this session" on button "Kill" → delete
- `AppShell.tsx:383` — tooltip "Read-only mode is enforced by the server." on badge "Read-only" → delete

Section subtitles restating the header/tab list:

- `DatabasePage.tsx:1470` — "Browse tables, views, routines, triggers, and events." → delete
- `SettingsPage.tsx:353` — "Connections, AI providers, review behavior, safety limits, appearance, and local data." (restates the six tabs) → delete
- `WorkspaceModals.tsx:133` — "Reusable statements stored on this machine." under "Saved snippets" → delete
- `ReportDetailPage.tsx:249,267` — "Saved audit or review." → delete (both branches)

Toggle/field descriptions restating the name:

- `SettingsPage.tsx:590` — Live lint: "Run static rules while you type. …" → keep only the second sentence ("Adds at most one review request per typing pause.")
- `SettingsPage.tsx:602` — Include schema by default: "Give the reviewer table, column, index, and foreign-key context." → "Sends table and index context with reviews." or drop
- `SettingsPage.tsx:739` — Cell size cap: "Long text and binary values are truncated…" → drop
- `SettingsPage.tsx:618` — AI context budget: "Schema and plan text are truncated to this budget…" → drop
- `ProviderForm.tsx:316,323` — "Useful for gateways that need extra headers." / "Merged into the provider request body." → drop
- `ConnectionForm.tsx:377` — "Limit which databases this profile can see and query." under "Database access" → delete
- `ConnectionForm.tsx:469` — "The database selector shows every database the MySQL user can see." → delete

Badges/captions stating the obvious:

- `PerformancePage.tsx:361` — badge "top 10" over a visibly-10-row list → delete or make it "showing 10 of N"
- `DatabasePage.tsx:667-681` — StatCard subs "InnoDB estimate", "DATA_LENGTH", "INDEX_LENGTH", "DATA_FREE" (MySQL column names as captions) → delete
- `SecurityPage.tsx:320` — badge "read from SHOW GLOBAL VARIABLES" → delete
- `SettingsPage.tsx:531` — "streaming"/"non-streaming" and "N max tokens" config chips → delete
- `ConnectPage.tsx:304` — badge "loopback" on a card listing 127.0.0.1 → delete
- `PracticePage.tsx:1453` — caption "result compared with the reference" under a badge saying "executed read-only" → keep badge, drop caption

Over-explaining empty states (keep the first sentence at most):

- `WorkspacePage.tsx:141` — "Run a statement to see warnings, timing, and affected-row information." → "Run a statement to see output."
- `WorkspacePage.tsx:1004` — third copy of the Ctrl+Enter shortcuts on this screen (placeholder + status bar already have it) → delete
- `ExplainPanel.tsx:42` — "Run Explain to see how MySQL executes the current statement, or use Review for a combined rule + plan analysis." → "Run Explain to see the execution plan."
- `ReviewPanel.tsx:224` — "Run Review to check this statement with deterministic rules, schema context, and optional EXPLAIN insights." → "Run Review to check this statement."
- `ReviewPanel.tsx:311` — "The rule engine did not find anything. Use Explain or an AI review for a second opinion." → "No rule findings."
- `ReportsPage.tsx:205` — "None of the N saved reports match the current tab and search." (tab counts already visible) → "Try a different tab or search."
- `Findings.tsx:212` — "Clear the filters or search for something else." (no Clear button exists) → "Adjust the filters above."
- `ReportDetailPage.tsx:252` — "This URL does not include a report id. Open a report from the list instead." → "Open a report from the list."
- `SecurityPage.tsx:122` — "The security audit reads accounts, grants, and server settings from the active connection. Choose a profile to run it." → "Choose a profile to run the security audit."
- `PerformancePage.tsx:205` — same shape → "Choose a profile to see live metrics."
- `PracticePage.tsx:1214` — "Choose tables and topics, then generate a set. You can answer with SQL or a written explanation…" → first sentence only
- `PracticePage.tsx:1191` — "Your topic mastery appears here after you submit answers. The lab tracks attempts locally…" → "Attempt stats appear after you submit answers."
- `WorkspaceModals.tsx:141` — "Save the current editor contents with a title and optional tags." (describes the form beside it) → delete
- `ConnectPage.tsx:493` — password modal explains what a password prompt is for → delete paragraph
- `Findings.tsx:175` — default `emptyCopy = 'Nothing to report here.'` → remove default

---

## P2 — Same fact narrated multiple times per screen/flow

The worst single-screen offenders:

- **AuditPage.tsx:225/226/274** — "stopped watching; audit continues on the server; report still saved" as inline message + toast + persistent caption → keep only the caption (274-277)
- **DatabasePage.tsx:1451/1463** — one load failure surfaced as page subtitle + danger callout + toast → keep the callout with Retry
- **DatabasePage.tsx:1494-1510/1514/1597** — table/view/routine/trigger/event counts shown as StatCards, a card-header badge, and sidebar badges → drop the card-header badge
- **AuditPage.tsx:247/353/415** — selected-database count shown three times → keep the header badge
- **ReviewPanel.tsx:556 vs 666** — the same AI privacy disclaimer twice in one panel → keep one
- **ReviewPanel.tsx:406 vs 432** — "ANALYZE executes the statement" as button parenthetical and warning line → keep one
- **WorkspacePage.tsx:1032** vs **ReviewPanel.tsx:507** — "review it before running" as toast and badge → keep the badge
- **WorkspacePage.tsx:890 vs 1055** — row cap shown in toolbar and status bar → keep the status bar
- **AppShell.tsx:376-431** — write-unlock state narrated by badge + hover title + callout + button → keep badge + "Lock now"; drop hover title and callout's second sentence
- **CreateDatabaseModal.tsx:136/153/186/285** — creation confirmed four times (toast, title, "X is ready.", callout) and irreversibility warned three times (157/220/285) → keep title + toast; keep one warning
- **UnlockDialog.tsx:79/80/121/137/158/189** — six restatements of "server enforces read-only / 15 min / you can re-lock" → subtitle "Unlocking lasts 15 minutes." + danger callout first line only
- **SettingsPage.tsx:670-674** vs **UnlockDialog** — the four-sentence write-safety callout duplicates the unlock dialog → two sentences max; drop "This cannot be disabled in the UI" (no such toggle exists)
- **SettingsPage.tsx:862 vs 947** — "reports and snippets are not deleted" as note and confirm text → keep in the confirm
- **PracticePage.tsx:879/1388/1444** — "graded without execution" stated three times → keep the badge only

Duplicated strings across screens (pick one canonical string):

- Delete-connection confirm: `ConnectPage.tsx:530` ("not touched") vs `SettingsPage.tsx:962` ("untouched") → one verbatim string
- Security paragraph: `ConnectPage.tsx:335-339` vs `SettingsPage.tsx:890-897` → one canonical blurb
- Compatibility string: `ConnectPage.tsx:420` tile + `:437` modal vs `SettingsPage.tsx:909` → keep the modal subtitle only
- "Save the profile first…" GRANT hint: `ConnectionForm.tsx:192` vs `:451` → one string
- "not executed" badge: `ConnectionForm.tsx:459` "Least-privilege SQL · not executed" vs `CreateDatabaseModal.tsx:200` "review only · not executed" → one phrasing
- Clear-history guard toast: `SettingsPage.tsx:331` vs `:848` → one string

---

## P3 — Terminology drift (one name per concept)

| Concept | Variants | Canonical suggestion |
|---|---|---|
| SQL text | "statement" (dominant) vs "query" (`WorkspacePage.tsx:816` "New query tab", `ResultsGrid.tsx:247`, `ReviewPanel.tsx:637`, SqlEditor placeholder) | **statement** |
| AI output | "AI executive summary" (AuditPage:424), "AI summary stream" (AuditPage:316), "AI summary" (AuditReportView:44), "AI review" (ReportDetail:167), "AI" badge (ReportsPage:224) | **AI summary** |
| Report list | "Past audits" (AuditPage:249), "Recent audits" (AuditPage:489), "All reports" (AuditPage:496), "Reports" (ReportDetail:291), "Back to reports" (ReportDetail:256) | **Recent audits** + "Back to reports" |
| Run the audit | "Run full audit" (AuditPage:479), "Run an audit" (ReportsPage:198), "New audit" (AuditPage:331) | **Run audit** (reset button may keep "New audit") |
| Connection | "connection" vs "profile" (mixed on ConnectPage, ConnectionForm, Settings) | **connection** |
| Create a connection | "Add a connection" (ConnectPage:285), "New connection" (ConnectPage:376/419), "Add connection" (Settings:390) | **New connection** |
| Practice items | route "Practice", title "SQL Lab", items are "challenges" / "questions" (1674) / "problems" (879) | **challenges** |
| Generate challenges | "New challenges" (872), "Generate challenges" ×3 (896/1061/1217) | one label |
| Provider | "provider" vs "AI provider" (ReviewPanel:352, Practice:938) vs "Configure AI" button | **provider** / "Add provider" |
| Abort streaming | "Cancel" (ReviewPanel:459) vs "Stop" (ReviewPanel:652); toast "cancelled" (WorkspacePage:503) vs "stopped" (ReviewPanel:216) | **Stop**, no toast |
| Test buttons | "Test connection" / "Test provider" / bare "Test" | **Test** |
| Save buttons | "Save changes" vs "Save provider" vs "Add connection/provider" | **Save X / Add X** pair |
| Pause polling | "Pause" (Performance:230) vs "Pause polling" (Performance:475) | **Pause/Resume** |
| Retry | "Try again" (Security:160) vs "Retry" (Reports:186) | **Retry** |
| Refresh sidebar | "Refresh schema" (collapsed, SchemaSidebar:276) vs "Refresh objects" (expanded, :519) | one |
| Filter placeholders | "Filter objects…" (DatabasePage:1309) vs "Filter tables and views…" (SchemaSidebar:548) | one |
| ANALYZE caveat | "(executes)" (ExplainPanel:93) vs "(executes the query)" (ReviewPanel:406) | "(runs the query)" |
| DDL artifact | "Create statement" header vs "Copy DDL" button (DatabasePage:875/877) | **DDL** |
| Severity rename | "high-impact" (SecurityPage:181, Findings:374) vs critical/high everywhere else | **critical or high** |
| Nav label | "Database" (AppShell:38) vs "Database explorer" (CommandPalette:66) | mirror the nav label |

Casing/grammar inconsistencies to sweep:

- lowercase "loading…" vs "Loading table…" (DatabasePage:1290/1445/1530/573); SchemaSidebar:288 "loading schema…" vs :212 "Loading columns…"
- lowercase shortcuts "ctrl+enter run" (WorkspacePage:1059) vs "Ctrl+Enter" elsewhere (845, 1004)
- lowercase badge `audit`/`review` (ReportsPage:222, ReportDetail:46) vs tabs "Audits"/"Reviews" — capitalize
- `all N` vs "All categories" inside Findings.tsx (106 vs 124)
- button noun "Selection" (WorkspacePage:847) among imperative siblings → "Run selection"
- "Executing…" (WorkspacePage:996) on a button labeled Run → "Running…"
- "Previous" vs "Next challenge" (PracticePage:1592/1600) — pair them
- "Load" vs "New tab" (WorkspaceModals:104/112) → "Load" / "Load in new tab"
- "Reports" vs "Back to reports" back buttons (ReportDetail:291/256)
- "Add your first provider" vs "Add provider" (Settings:499/481)
- Command palette "Create a database" vs sibling imperatives without articles (CommandPalette:86)

---

## P4 — Parallel-triad cadence and marketing voice

The "A, B, and C" rhythm — cut each to one item or delete:

- `AuditPage.tsx:243` — "…with transparent coverage and an optional AI executive summary." → "Run all checks against the selected databases."
- `AuditPage.tsx:534-543` — the "What the audit covers" card: six consecutive triads ("Primary keys, foreign keys, and index design", "Slow queries, full joins, temp-table spills, and replication"…) → collapse to one line or delete the card
- `WorkspacePage.tsx:141` — "warnings, timing, and affected-row information"
- `ResultsGrid.tsx:214` — "Add a LIMIT, narrow the predicate, or raise the cap in Settings." → "Result capped at N rows — adjust in Settings." (and drop the duplicate "capped" badge at 147)
- `ResultsGrid.tsx:318` — "passwords, tokens, or personal data" → "credentials or personal data"
- `ReviewPanel.tsx:352` — "second opinion, rewrite suggestions, and a structured deep review" → "Add a provider to enable deep review."
- `ReviewPanel.tsx:588` — "Ask why a rule fired, how an index would change the plan, or whether a rewrite is safe." → "Ask why a rule fired or whether a rewrite is safe."
- `ReviewPanel.tsx:556` — "the SQL, referenced schema, deterministic findings, and (if enabled) the EXPLAIN plan — only when you click Deep review." → "Deep review sends the SQL and schema to the selected provider."
- `ConnectPage.tsx:271` — five-verb hero: "explore schemas, run safe queries, review EXPLAIN plans, audit access, and practice with SQL Lab." → "Pick a connection to browse schemas, run queries, and review plans."
- `SecurityPage.tsx:177` — "Account inventory, authentication posture, privilege flags, and server-side security settings." (also diverges from :117) → one subtitle for all branches: "Accounts, grants, and server configuration."
- `PerformancePage.tsx:200` — "throughput, sessions, slow work, and configuration" → "Live throughput, sessions, and configuration."
- `PracticePage.tsx:879` — "Generate reviewer-style problems, answer them, and compare…" → "Generate challenges, answer them, and compare with a reference solution."
- `SecurityPage.tsx:236` — "Set passwords, restrict accounts to localhost, and keep MySQL bound to 127.0.0.1…" → see P6 (unconditional callout)

Miscellaneous filler:

- `AuditPage.tsx:418` — StatCard "Rules: 50+ / deterministic" is a static marketing number → delete
- `AuditPage.tsx:481` — "Read-only checks. Nothing is modified." → "Read-only — nothing is modified."
- `AuditPage.tsx:339` — "Open saved report" → "Open report"
- `DatabasePage.tsx:272` — "Click a node to open it." → delete sentence
- `SchemaSidebar.tsx:419` / `PerformancePage.tsx:631` — "Refine the search/filter." → "Showing first 400." / "Showing first 800 of N."
- `PerformancePage.tsx:419` — "This server is not configured as a replica. Replication checks are skipped." → "Not configured as a replica."
- `ReportDetailPage.tsx:106` / `Findings.tsx:348` — "(s)" pluralization ("statement(s)", "instance(s)") → pluralize properly
- `ReportsPage.tsx:261` — "MD" vs "Markdown" (ReportDetail:80) → pick one
- `WorkspacePage.tsx:920` — "No database selected. Statements that rely on the default database may fail — choose one in the top bar." → "No database selected — choose one in the top bar." (fourth variant of this message across screens; consolidate)

---

## P5 — Reassurance and lecture voice

Security/local claims stated far too often — one canonical line each:

- "encrypted (AES-256-GCM / local key)" appears at `ConnectPage.tsx:335`, `SettingsPage.tsx:472`, `:928`, `ProviderForm.tsx:243`, `ConnectionForm.tsx:341`, `:356` → keep the ProviderForm/ConnectionForm hint only
- "local / on this machine / nothing uploaded" at `ConnectPage.tsx:259`, `:427-429`, `SettingsPage.tsx:890-897`, `WorkspaceModals.tsx:207`, `PracticePage.tsx:1069-1072` → one footer line on Connect
- "read-only by default" per profile card (`ConnectPage.tsx:131`) → once per page
- `ConnectionForm.tsx:436` — "The profile allowlist is a workflow guardrail. A restricted MySQL user and grants are the real security boundary." → "Grants, not this list, are the security boundary." or move to docs
- `SettingsPage.tsx:681` — masking disclaimer "This is a safety net, not a substitute for database grants." → "Not a substitute for grants."
- `UnlockDialog.tsx:137` — "This phrase is checked by the server, not just the UI." → delete
- `UnlockDialog.tsx:189` — "The server still enforces single-statement execution and the configured timeout." → delete
- `SettingsPage.tsx:811` — "The theme is stored in your MyLens settings on this machine." → delete
- `ConnectionForm.tsx:346` — "Optional. The workspace database selector still works." → delete
- `ConnectionForm.tsx:513` — leaks the Node option name: "Verify the server certificate (rejectUnauthorized)" → drop parenthetical
- `ReviewPanel.tsx:379` — hint "`${provider.type} endpoint`" (tech-stack detail) → delete
- `Findings.tsx:373-375` — "high-impact finding(s) need attention before you run this in production… verify any rewrite against EXPLAIN." → delete the component (severity chips carry the counts)
- `CreateDatabaseModal.tsx:208` — "…if you want a dedicated user restricted to this database." → "Replace the password placeholder before running this as an admin."
- `SettingsPage.tsx:785-787` — theme flavor text ("Deep charcoal with ember accents.", "Warm light theme for daylight.") → labels only

Gamification/congratulation slop (Practice):

- `PracticePage.tsx:733-737` — toasts "Correct. Nicely done." / "Close. Review the differences and try again." / "Answer reviewed. Read the feedback and reference." → "Correct." / "Close." / "Reviewed." (the evaluation card carries the detail)
- `PracticePage.tsx:723` — "Already submitted — this answer was recorded earlier and was not counted again." → "Duplicate answer — not counted again."
- `PracticePage.tsx:1191, 1756` — "topic mastery" (twice) → "attempt stats" / "attempt history"
- `PracticePage.tsx:1083` — "Designing challenges from X…" → "Generating challenges…"
- `PracticePage.tsx:836, 879` — "grounded" (AI-jargon) → drop
- `PracticePage.tsx:1042` — "Include a few masked sample rows" → "Include masked sample rows"
- `PracticePage.tsx:1047` — "Use AI feedback after deterministic grading" → "Add AI feedback after grading"
- `PracticePage.tsx:1524` — lightbulb "Next hint" callout after grading → fold into the feedback block
- `CreateDatabaseModal.tsx:103` — charset description "Unicode, including emoji" → drop
- `WorkspacePage.tsx:1003` — results placeholder title "Ready when you are" → "No results yet"
- `SqlEditor.tsx:294` — "-- MySQL runs here. Press Ctrl+Enter to execute." → "-- Write SQL here" (shortcuts already live in the status bar)

Trivial-action toasts to delete:

- `WorkspacePage.tsx:538` "SQL formatted." · `WorkspacePage.tsx:503` "AI review cancelled." · `ReviewPanel.tsx:216` "AI chat stopped." · `PracticePage.tsx:551` two-sentence DB-switch toast → shorten to one clause
- `ResultsGrid.tsx:204` / `ReviewPanel.tsx:546` copy toasts — optional; keep only if phrased identically

---

## P6 — Genuine defects (fix regardless of style)

1. **`WorkspacePage.tsx:1058` — "last run Xm ago" is the query duration, not elapsed time.** `lastRunLabel(activeTab.result.executionMs)` (WorkspacePage.tsx:52) formats how long the statement *ran* as an "ago" label: a query that ran 30 seconds reads "last run 30s ago" forever and never updates. Relabel to "runtime 30s" or store an actual completion timestamp.
2. **`SecurityPage.tsx:234` — the "This is a local XAMPP server." callout renders unconditionally** (not gated on any detection) with a 3-sentence hardening lecture that is wrong advice for any non-XAMPP server. Gate on real detection and shorten to one sentence.
3. **`ProviderForm.tsx:335-341` — "Stream responses" label rendered twice** (Switch `label` prop + a visible `<span>`). Remove one.
4. **`DatabasePage.tsx:937` — `SparklesIcon()` returns a `RefreshCw` glyph**, used on the "No triggers" empty state. Name and glyph disagree; use a purposeful icon.
5. **`ui.tsx:796` — ScoreRing renders the literal placeholder "SCORE"** when no grade is passed. Hide the line instead.
6. **`ui.tsx:528` — ConfirmDialog default button "Confirm"** names no action; `ui.tsx:381` — untitled modals get the accessible name "Dialog". Require a verb / an aria-label in dev.
7. **`ui.tsx:303` — SearchInput has no aria-label**; placeholder is its only name. Add `aria-label={placeholder}`.
8. **`BottomNav.tsx:82 vs 90`** — modal aria-label "More sections" vs visible title "More"; **`CommandPalette.tsx:171 vs 223` + AppShell:402** — "Command palette" / "Commands" / "Commands" for one control. Align aria labels with visible labels.
9. **`WorkspacePage.tsx:890-892`** — toolbar shows "cap N rows · Xs timeout" duplicating the status bar's "row cap N" on the same screen (see P2).
10. **`DatabasePage.tsx:562-565, 636-641, 1485-1490` + `ExplainPanel.tsx:88`** — buttons swap a spinner icon *and* set `loading`, double busy indicators. Keep `loading` only.
11. **`Findings.tsx:212`** — empty-state copy promises "Clear the filters" but no Clear button exists (see P1).
12. **`App.tsx:93`** — boot-error screen offers "Open dev UI" — internal jargon; name it or hide it.

Note: `ResultsGrid.tsx:124` exports `mylens-query-result.csv` — checked and **not** a defect: "MyLens" is the product's own in-app name (ConnectPage footer, prompts, exports), so the filename is consistent branding.

---

## P7 — Server-side AI output (the literal AI slop surface)

- `server/ai/analyze.ts:196` — when the model returns no recommendation, users see the hedge "Review the suggestion against the schema and verify it with EXPLAIN before changing production code." → omit the field instead of shipping filler
- `analyze.ts:233` — fallback summary "AI review completed." (content-free) → "The model did not return a summary." or drop the block
- `analyze.ts:241` — fallback rewrite note "The reviewer suggested this rewrite." → omit when absent
- `server/ai/prompts.ts:140` — chat prompt sanctions "markdown with headings and bullet points" → the classic bold-header AI look; change to "Use code blocks for SQL; keep formatting minimal."
- `prompts.ts:175-181` — the audit-summary prompt mandates a fixed 5-section skeleton (Overall health / Top risks / root causes / Prioritized actions / Coverage gaps); every summary ships identical headings. Defensible for an executive summary — optional: ask for the content in order without naming the sections.
- `server/ai/practice-prompts.ts:143` — "Be encouraging but precise." invites cheerleading in the `strengths` slot → "Be factual; praise only specific correct technique."
- `server/review/report.ts:25,37` — every finding/group line in exports gets `**[SEVERITY] Title**` bold-bracket formatting; conventional for reports, but softening is an option.
- `report.ts:196 vs 384` — markdown and HTML exports carry **different** disclaimer footers ("Generated by MyLens — local MySQL review studio…" vs "Generated by MyLens…"). Share one string.

Clean (verified, no action): all deterministic rule recommendations are specific imperatives with real SQL; `errors.ts` maps real conditions to actionable messages; audit progress labels are concrete; no "It is recommended to…", "Best practice suggests…", "well-formed and efficient", or "However, please note…" anywhere in server templates.

---

## Suggested fix order

1. **Pure deletions** (P1 captions/copy, P2 duplicate surfaces, P5 toasts) — ~40 strings, zero risk, biggest noise drop.
2. **Terminology sweep** (P3) — pick canonical terms, one pass per file; introduces a shared strings module if drift should never return.
3. **Defects** (P6) — small code fixes; the "last run" mislabel and unconditional XAMPP callout are user-visible wrongness.
4. **AI output templates** (P7) — prompt tweaks + filler-fallback removal.
5. **Cadence rewrites** (P4/P5 prose) — copywriting pass, best done last on stable terminology.
