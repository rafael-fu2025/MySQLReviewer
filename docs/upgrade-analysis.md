# MyLens — Full-Stack Upgrade Analysis

> Produced 2026-11-07 by a four-agent deep review (Frontend, Backend, SQL Lab product/competitive, Platform/Security), each grounded in the actual code with file references and supplemented with web research on competing SQL tools, MySQL 8/MariaDB 11 capabilities, and current ecosystem versions.
>
> Scope: **everything that makes an upgrade to the existing app — full stack**. Execution-first identity respected (no lesson content proposed). Architecture deliberately excluded.

---

## 1. Current state in one paragraph

MyLens is a genuinely differentiated local-first MySQL/MariaDB studio: read-only-by-default execution with an `UNLOCK WRITES` gate, 111 deterministic review rules + 9 EXPLAIN heuristics with weighted scoring, EXPLAIN/ANALYZE plan trees, performance/security audits, schema-grounded AI practice generation with real-database grading (SQL Lab), a multi-provider AI assistant with tool-calling, credential masking, scoped profiles, and AES-256-GCM secrets at rest. The gaps are almost all _around_ the core, not in it: the SQL Lab judge has fairness edge cases and no retention loop, the results grid has no sort/filter/charting, MySQL EXPLAIN ANALYZE runtime data is captured but never used, performance_schema coverage is shallow, and the platform layer (CI, distribution, packaging) hasn't caught up with the code.

---

## 2. Top 12 upgrades (cross-agent consensus ranking)

| #   | Upgrade                                                                                                                                                                                 | Theme       | Effort | Impact   |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------ | -------- |
| 1   | **SQL Lab grading fairness + judge trust** — numeric-tolerant comparison, mask-safe diffing, multiple accepted reference solutions, robust `orderMatters` handling                      | SQL Lab     | M      | High     |
| 2   | **SQL Lab learning loop** — spaced-repetition review queue, daily challenge + streaks, first-class progress dashboard, hint ladders, skills taxonomy/mastery map                        | SQL Lab     | M–L    | High     |
| 3   | **EXPLAIN ANALYZE runtime parsing for MySQL** — parse `actual time/rows/loops` from the tree; today all runtime findings are dead rules on MySQL; add estimated-vs-actual drift finding | Diagnostics | M      | High     |
| 4   | **Query-result charting** — bar/line/pie/scatter from any result set; PopSQL's headline feature, completely absent                                                                      | Frontend    | L      | High     |
| 5   | **performance_schema/sys depth** — digest enrichment (`SUM_NO_INDEX_USED`, `QUANTILE_95/99`, tmp-disk), lock-wait view, table I/O hotspots                                              | Diagnostics | M      | High     |
| 6   | **Interactive results grid** — column sort/filter, cell inspector (JSON tree/hex/long text), copy-as TSV/Markdown/SQL-INSERT, XLSX                                                      | Frontend    | M      | High     |
| 7   | **Streaming + multi-statement execution** — stream large results over SSE; "Run script" with per-statement outcomes (import path already has the machinery)                             | Backend     | M      | High     |
| 8   | **AI proposal diff/apply** — diff proposal vs buffer, insert at caret (today "Insert into editor" replaces the whole tab), keep partial streams after cancel                            | AI/Frontend | M      | High     |
| 9   | **AI cost accounting + controls** — persist `usage` per action (practice discards it today), per-user budget, prompt caching, structured output modes                                   | AI          | S–M    | Med–High |
| 10  | **Platform hardening** — Node LTS alignment, CI windows+build+secret-scan+rules-snapshot, Playwright e2e, Express 5, portable/Tauri distribution                                        | Platform    | M–L    | High     |
| 11  | **Schema explorer + History v2** — column search across tables, pinned tables, schema ERD; server-side history search/diff/re-run                                                       | Frontend    | M      | Med–High |
| 12  | **Data-tool quality** — keyset-paginated dump, streaming/gzip export, EVENT export (silently dropped today), schema diff → migration script generation                                  | Backend     | S–L    | Med–High |

---

## 3. Theme A — SQL Lab & practice (the differentiator)

**What exists today** (from code): AI-only generation (SSE, JSON-repair retry) over up to 20 schema tables with masked 5-row samples; 4 task types (`write-query`, `fix-query`, `review-query`, `concept`), 13 topics, 3 difficulties; reference SQL validated read-only against the real DB before acceptance; grading by row-multiset comparison (order-insensitive unless `orderMatters`) plus static rules scoring — correctness 60% / performance 25% / style 15%; hints regex-filtered for answer leakage; answers gated until first attempt; progress per connection profile in `practice.json` (40 sets / 1,500 attempts, last 500 attempts for stats).

**Competitive landscape** (researched): DataLemur (XP, streaks, daily problems, topic taxonomy with counts, hints per question), LeetCode SQL 50 (7-section curated ladder, "any order" judge convention), StrataScratch (multiple community solutions per question), HackerRank (6-star badge ladder + timed certifications), sql-practice.com (closest philosophical match — fixed Northwind/Hospital datasets, keyword filters), DB Fiddle (share permalinks). Key insight: **MyLens already owns the hardest-to-copy asset (real DB + real execution + rules engine)**; what's missing is everything around the judge — retention loop, curriculum structure, retrieval practice, and comparison UX. **No competitor ships spaced repetition natively** — open differentiator.

### Upgrades

1. **Column-aligned side-by-side result diff** — replace raw-JSON missing/extra `<pre>` blocks and two separate collapsible grids with a paired, cell-level red/green diff. The comparison moment is the product's core UX. → `server/db/practice.ts` (emit column/cell diff metadata), `src/pages/PracticePage.tsx` (`ComparisonView`). _M / High_
2. **Multiple accepted reference solutions + robust matching** — validate several `referenceSql[]` candidates; auto-detect nondeterministic ORDER BY and downgrade to set comparison (LeetCode convention); optional column-name-agnostic mode. Judge trust is existential. → `shared/types.ts`, `server/ai/practice.ts`, `server/db/practice.ts`. _M–L / High_
3. **Spaced-repetition review queue** — SM-2-lite/2357 resurfacing of missed challenges; hub shows "Review due today"; ~80% of the data model (setId/questionId/topics/scores/timestamps) already persisted in `server/store/practice.ts`. _M–L / High_
4. **Daily challenge + streaks + XP + progress dashboard** — promote progress out of the setup modal (`PracticePage.tsx:1189–1254`); streak computable from attempt `createdAt`; daily set = 1-question generate call. _M / High_
5. **Skills taxonomy + mastery map + guided ladders** — level the flat 13-topic list (foundation → joins → aggregation → subqueries → CTEs → window functions → set ops → optimization) with mastery per node and LeetCode-SQL-50-style preset ladders. _M–L / High_
6. **Query-quality grading** — compare user vs reference `executionMs` and EXPLAIN plan shape ("correct, but 40x slower and scans `orders`"); reserve full performance credit within a factor of reference. No competitor can measure timing on a real server. _M / High_
7. **Hint ladders** — three structured tiers (nudge → approach → partial SQL), `hintsUsed` recorded per attempt and factored into XP. Today hints are flat free-form strings. _S–M / Med–High_
8. **EXPLAIN-reading drills** — new `explain-plan` question type ("which index is used / why is this slow"); no competitor drills plan reading interactively; leverages existing `runExplain` + rules engine. _M / Med–High_
9. **Per-question attempt history + retry semantics** — show trajectory; mark retried attempts superseded for mastery averages (they currently inflate topic counts). _S / Med_
10. **Timed exam mode** — countdown, hints off, no run-preview, end-of-session report (HackerRank certification precedent). Mostly UI state. _M / Med_
11. **Shareable/importable sets** — JSON export; import re-validates every reference via existing `validateReferenceSql`; optionally ship a curated Northwind starter pack. _M / Med_
12. **Achievements/badges** — pure derivation from attempt history. _S–M / Med_
13. **"Explain your query" free-text grading** — optional rationale field for executed answers, cross-checked against the structural keyword detector (`db/practice.ts:324–345`). _S–M / Med_
14. **AI-independent pattern library** — built-in schema-agnostic challenge templates (top-N per group, gaps-in-time, running totals, dedup) with pre-written reference SQL, so SQL Lab works with zero AI and generation failure degrades gracefully. Today generation hard-requires a provider (`ai/practice.ts:410–417`). _L / Med–High_
15. **Persist navigator flags + keyboard navigation** — flags are session-only today (`PracticePage.tsx:655–668`). _S / Low–Med_

### Grading-fairness fixes (backend, fold into #1/#2)

- **Numeric-tolerant canonicalization** — with `bigNumberStrings:true, decimalNumbers:false` (`server/db/manager.ts:159–161`), `12.30` ≠ `12.3` grades wrong on aggregate challenges. (`server/db/practice.ts:125–159`) _S / High_
- **Mask-safe comparison** — rows are masked before diffing (`server/db/query.ts:386–391`); an aliased sensitive column masks differently than the reference and flips the verdict. Compare unmasked server-side with a mask-count check. _M / High_
- **Anti-cheat: strip referenceSql from AI-evaluation prompts** for executable questions until the verdict is locked (`server/ai/practice-prompts.ts:194–236` currently sends it). _S / Med_
- **`hintRevealsAnswer` false positives** — the regex drops benign hints containing "select … from" in plain English (`server/db/practice.ts:32–40`). _S / Low_
- **200-row cap** — challenges whose answers legitimately exceed 200 rows grade as truncated (`server/ai/practice.ts:782–796`). Add `expectedRowCount` guard. _S / Low_

---

## 4. Theme B — SQL editor & results grid

**What exists today**: CodeMirror 6 with MySQL dialect, schema-aware autocomplete, live lint wired to the real rule engine (900 ms debounce), caret-based statement run; typed result cells with masking + confirm-gated reveal, CSV/JSON export, client-side pagination fixed at 100 rows/page.

### Editor

| Upgrade                                                                                                                       | Where                                        | Effort | Impact |
| ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | ------ | ------ |
| SQL snippets as completions (`sel→…`, `join`, `cte`, window templates) + saved snippets as a completion source                | `SqlEditor.tsx:158–168`, `db-api.ts:237–247` | M      | High   |
| Hover tooltips for tables/columns (type/PK/FK) via `hoverTooltip()`                                                           | `SqlEditor.tsx:242–255`                      | M      | Med    |
| Format options + format-selection (currently hardcoded `keywordCase:'upper', tabWidth:2`)                                     | `WorkspacePage.tsx:593–607`                  | S      | Med    |
| Editor settings (font size/family, tab size, wrap); fix hardcoded `dark:true` at `SqlEditor.tsx:72`                           | `ui-store.ts`                                | S      | Med    |
| Run-per-statement script mode with per-statement result list (import path already does this: `db-api.ts:105–134`)             | `WorkspacePage.tsx:345–412`                  | M      | High   |
| Query variables/params (`:name` prompt) — makes restore-then-run of parameterized history usable                              | execute path                                 | M      | Med    |
| Statement boundary decoration + navigation (server already picks the caret statement)                                         | `SqlEditor.tsx`                              | M      | Med    |
| Inline parse errors as CM6 diagnostics (don't wait for a failed run)                                                          | `SqlEditor.tsx:170–207`                      | M      | Med    |
| `selectNextOccurrence` binding (multi-cursor is enabled but the command isn't bound — verified absent in the installed build) | `SqlEditor.tsx:209–240`                      | S      | Low    |

### Results grid

| Upgrade                                                                                                                                             | Where                                      | Effort | Impact |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ------ | ------ |
| **Charting** (bar/line/pie/scatter, PNG/SVG export) — can start dependency-free from the existing `Sparkline` pattern (`PerformancePage.tsx:40–70`) | `ResultsGrid.tsx` new tab                  | L      | High   |
| Column sort + quick filter row (DatabasePage's data preview has server-side sort; the results grid has none)                                        | `ResultsGrid.tsx:114–148`                  | M      | High   |
| Cell inspector: JSON tree, full text, hex view for binary (long values truncated at 160–180 chars)                                                  | `ResultsGrid.tsx:8–55`                     | M      | High   |
| Copy as TSV / Markdown / SQL-INSERT (clipboard is JSON-only today; TablePlus/DBeaver offer 6+ formats)                                              | `ResultsGrid.tsx:213–260`, `lib/format.ts` | S      | Med    |
| Export XLSX + export selection                                                                                                                      | `ResultsGrid.tsx:180–192`                  | M      | Low    |
| Pagination quality: page-size selector, jump-to-page, honest totals when truncated, optional virtualization                                         | `ResultsGrid.tsx:153–176, 298–324`         | M      | Med    |
| Column actions: hide/reorder/pin, quick stats                                                                                                       | `ResultsTable`                             | M      | Low    |

### Schema explorer / history / commands

- **Column search across tables** ("which tables have `customer_id`") — search currently matches table/view names only. `SchemaSidebar.tsx:146–158`. _M / High_
- **Pinned/favorite tables** — persist in `ui-store`; tree silently hard-cuts at 400 tables (`SchemaSidebar.tsx:345, 406–408`). _S / Med_
- **Whole-schema ERD** — only a per-table FK mini-map exists (`DatabasePage.tsx:216–410`). _L / Med_
- **Copy DDL / generate SELECT from the tree**. _S / Low_
- **History v2**: server-side search + pagination (client fetches `limit=150` at `db-api.ts:227–231` and substring-filters — older entries unreachable), Re-run button, diff two entries, filter chips. _M / High_
- **Command palette v2**: fuzzy matching, schema objects/snippets/history as items, shortcut hints, wrap-around keys, scroll highlighted option into view (`CommandPalette.tsx:170–237`). _M / Med_
- **Replace Ctrl+T** (reserved by browsers — the in-app new-tab shortcut silently never fires; `WorkspacePage.tsx:803–815`) and add a `?` shortcut cheatsheet. _S / Low_
- **AI assistant extras**: attach last EXPLAIN/findings to chat context, conversation browser (server already persists threads), regenerate/feedback buttons. _S–M / Low–Med_

---

## 5. Theme C — Query engine & diagnostics (backend)

**What exists today**: single-statement caret execution over a 4-conn mysql2 pool (`multipleStatements:false`, text protocol), `max_statement_time`/`max_execution_time` + KILL watchdog, `sql_select_limit` row cap (10k hard max); EXPLAIN FORMAT=JSON tree with ~9 heuristic findings; metrics: global status/variables, processlist+KILL, digest top-20, slow-log tail, replication — performance_schema used for exactly 2 things.

| Upgrade                                                                                                                                                                  | Where                                   | Effort | Impact   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------- | ------ | -------- |
| Parse MySQL `EXPLAIN ANALYZE` tree (`actual time=/rows=/loops=`) into `runtimeMs/runtimeRows/loops` — today `explain.slow-node`/`slow-runtime` only ever fire on MariaDB | `server/db/explain.ts:427–445, 273–295` | M      | High     |
| Estimated-vs-actual drift finding (MariaDB `r_rows` already captured but never compared — bad statistics are the #1 plan problem)                                        | `explain.ts:172–313`                    | S      | High     |
| Optimizer trace viewer (`SET optimizer_trace` → `information_schema.OPTIMIZER_TRACE`) — "why this plan" pane                                                             | new module                              | M      | High     |
| Histograms: `ANALYZE TABLE … UPDATE HISTOGRAM` (MySQL) / EITS `PERSISTENT FOR` (MariaDB) + stale-histogram rule                                                          | `index-advisor.ts`, new rules           | M      | Med      |
| `EXPLAIN FOR CONNECTION` (MySQL) / `SHOW ANALYZE` (MariaDB 10.11) — "inspect running query" next to the processlist kill button                                          | `metrics.ts:66–81`                      | S      | Med–High |
| EXPLAIN for DML/CTE-writes (MySQL 8.0.18+; classifier already handles `WITH … INSERT`)                                                                                   | `explain.ts:342–367`                    | S      | Med      |
| Streaming results over SSE (all rows buffered+masked in memory today; 10k ceiling)                                                                                       | `query.ts:351–411`, `sse.ts`            | M      | High     |
| Multi-statement script runs with per-statement SSE progress                                                                                                              | `query.ts:232–258`                      | M      | High     |
| Prepared statements (`conn.execute`) for hot internal paths (table preview, practice re-runs, audit snapshots)                                                           | `introspection.ts:792–854`              | S      | Low–Med  |
| Compression protocol (`compress:true`) for remote/TLS profiles                                                                                                           | `manager.ts:144–164`                    | S      | Low      |

**performance_schema / sys / config:**

- Digest enrichment: `SUM_NO_INDEX_USED`, `SUM_NO_GOOD_INDEX_USED`, `SUM_CREATED_TMP_DISK_TABLES`, `QUANTILE_95/99` (MySQL 8.0.19+) — "statements with full scans" à la sys. (`metrics.ts:280–312`) _S / High_
- Lock-wait view: `performance_schema.data_lock_waits` (MySQL 8) / `INNODB_TRX`+`INNODB_LOCK_WAITS` (5.7/MariaDB) with blocking chain + "EXPLAIN the victim". New module. _M / High_
- Table/file I/O hotspots beyond `DATA_LENGTH` ordering (`table_io_waits_summary_by_table`). _S / Med_
- Persist metric samples (currently in-memory only, `metrics.ts:89`) as a JSONL ring for trends feeding audit scores. _M / Med_
- Config rules: add `innodb_flush_log_at_trx_commit`, `sync_binlog`, `tmp_table_size` vs `max_heap_table_size`, `table_open_cache`/`thread_cache_size` pressure, `binlog_format`, `innodb_log_file_size`, `explicit_defaults_for_timestamp`. _S / Med_
- Slow-log parser: MariaDB omits repeated `# Time:` lines — anchor on `SET timestamp=` and split on `User@Host` (`metrics.ts:180–264`). _S / Med_

---

## 6. Theme D — Review / rules engine

- **New rule packs**: generated/functional columns (introspected but unused — `introspection.ts:177`), partitioning (partitions read but zero rules — `introspection.ts:398–419`), trigger/routine `sql_mode` drift (`introspection.ts:276`), "EVENTs defined but `event_scheduler=OFF`" (XAMPP default), literal-heavy-statement / FK-cascade-chain / ENUM+BLOB smells. _S–M each / Med_
- **Index advisor quality**: use `CARDINALITY` (captured at `introspection.ts:192` but ignored) for selectivity ranking; skip FK-covered columns (redundant with `schema.fk-without-index`); multi-statement aggregation; EXPLAIN-verify suggestions. _S–M / Med_
- **Scoring**: use the existing `confidence` field (unused by `scoring.ts:4–12`); scale-weight findings (a full scan on 50 rows shouldn't score like 5M rows). _S / Low–Med_
- **Full-scan noise gate**: `explain.full-table-scan` fires at medium severity for 5-row lookup tables (`explain.ts:179–188`) — on the README's own Northwind demo nearly every query produces findings, training users to ignore them. _S / Low_
- **Digest cross-reference**: pipe "digest with SUM_NO_INDEX_USED" back into rules as query findings (`audit.ts:342–390`). _M / Med_

---

## 7. Theme E — AI layer

| Upgrade                                                                                                                                                                                                                                                  | Where                              | Effort | Impact   |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- | ------ | -------- |
| Persist `usage`/cost per action (practice generation/evaluation discards it: `ai/practice.ts:667–691`); daily budget in settings; per-user spend cap for members using admin-configured providers (`routes/ai.ts:254–256` gates on assignment, not cost) | `ai/*`, `routes/ai.ts`             | S–M    | Med–High |
| Prompt caching — Anthropic `cache_control` for the static system+schema prefix (big win on audit/review shapes)                                                                                                                                          | `ai/anthropic.ts`, `ai/prompts.ts` | S      | Med      |
| Structured output / JSON mode (`response_format` / `responseMimeType`) to eliminate repair round trips (each repair is a second bill)                                                                                                                    | `ai/openai.ts`, `ai/google.ts`     | S      | Med      |
| Retry with backoff on `AI_UPSTREAM` for non-streaming `complete()` (non-retryable codes are already distinguished)                                                                                                                                       | `ai/analyze.ts:443–461`            | S      | Med      |
| MCP surface: per-profile MCP server config + tool governance UI (`agent-mcp.ts` exists, 324 lines)                                                                                                                                                       | `ai/agent-mcp.ts`                  | M      | Low–Med  |

---

## 8. Theme F — Data tools, history, reports

- **Keyset-paginated dump** — `LIMIT/OFFSET` without ORDER BY (`import-export.ts:465–468`) is non-deterministic under concurrent writes and O(n²); `provision.ts:48–65` already has the correct keyset pattern. _S / High_
- **Streaming/gzip export** — whole dump assembled in memory (`import-export.ts:245–356`); 1 GB DB OOMs the server. _M / Med–High_
- **Export EVENT objects** — documented in `includeObjects` but never emitted (`import-export.ts:294–345`); restores lose scheduled events. _S / Med_
- **Schema diff → reviewable ALTER script** (dump vs live / DB vs DB) — reuses snapshot + import-gate infra; highest-value missing data tool. _L / High_
- **Server-side CSV import path**; one-click "load Sakila/Northwind into sandbox" via provision. _M / Med_
- **Persist EXPLAIN digest + finding ids with history** → enables "what changed after I added the index"; analytics (success rate, per-table frequency, latency trend) are derivable from existing entries; audit-vs-audit diff for scheduled audits. _S–M / Med_
- **Dump header honesty** — `SET FOREIGN_KEY_CHECKS=0` headers are written but in-app import classifies them as session statements that never run, and statements may hit different pooled connections; drop or annotate (`import-export.ts:264–268`). _S / Low_

---

## 9. Theme G — Platform, security, CI, distribution

**Snapshot**: CI is a single ubuntu/Node 20 job (typecheck, lint, format, vitest) — no build step, no Windows job, no audit, despite Windows being the primary target. 64 vitest files, strong on rules/scope/crypto/masking; ~15 manual `verify-*.mjs` browser scripts and a manual pixel-diff pipeline with a hardcoded Chrome path. Secret scanner (`scripts/secret-scan.py`) wired to nothing.

### Version upgrades

| Item                                                                                                                                                              | Notes                                                                                            | Effort | Impact   |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------ | -------- |
| Node LTS alignment: `engines` field, `.nvmrc`, CI on Node 22/24                                                                                                   | Node 20 EOL 2026-04-30; Vite 7 needs ≥20.19 — a Node 18 user gets an opaque `start.bat` failure  | S      | High     |
| CI hardening: windows+ubuntu matrix, add `npm run build`, secret-scan step, `npm audit` + Dependabot, nightly smoke + rules-snapshot check on a MariaDB container | Commit 4b8fd53 shows Windows breakage is real                                                    | S–M    | High     |
| Express 4 → 5.1                                                                                                                                                   | Only 2 wildcard routes to fix (`server/index.ts:316, 319`); do it while the surface is 15 routes | M      | Med–High |
| Vitest 3 → 4                                                                                                                                                      | Stable browser mode + built-in visual regression — subsumes the CDP harness; minimal config here | S–M    | Med      |
| Zod 3 → 4 via `zod/v4` subpath                                                                                                                                    | Already on 3.25.76 which ships v4                                                                | S      | Med      |
| Vite 8 (Rolldown)                                                                                                                                                 | Later; plugin ecosystem check first                                                              | M      | Med      |
| mysql2 / node-sql-parser / React / Tailwind                                                                                                                       | Current & patched; automate with Dependabot; run `rules:snapshot` in CI on dependency PRs        | S      | Low–Med  |

### Security hardening

- **CSP header** — all other hardening headers present (`index.ts:114–118`); missing CSP while rendering model-controlled markdown. _S / Med_
- **General rate limiter** beyond login (`/api/ai`, `/api/db` unthrottled; matters if `MYLENS_ALLOW_REMOTE_HOST=1`). _S / Med_
- **Per-user AI spend caps** (see Theme E). _M / Med_
- **Master-key handling** — `.secret.key` co-located with ciphertext in `data/` (0600+ACL good; next step: opt-in Windows DPAPI/keychain `v2:` envelope; `v1:` prefix already supports rotation). _M / Med_
- **`timingSafeEqual` for the master token** (`index.ts:264` compares with `!==`). _S / Low_
- **Remote-mode posture** — no `Secure` cookie flag (`sessions.ts:96`), origin check trusts client-controlled Host with no trust-proxy (`index.ts:148`), only a console warning (`index.ts:413–417`); add persisted acknowledgement. Persist login throttle across restarts (`routes/auth.ts:53`). _S / Low–Med_
- Verified non-issues: no path traversal (all writes via fixed-path JsonStore), SSL files pinned to DATA_DIR, provider SSRF guard incl. metadata hosts, scrypt+timingSafeEqual passwords, bootstrap withheld from anonymous callers.

### Testing / distribution / DX

- **HTTP-level route tests** (supertest against the exported app; `MYLENS_NO_LISTEN=1` hook already exists) — lock in the 401/403 gate ladder per route family. _M / High_
- **Playwright e2e** for the 5–6 core flows; consolidate the ~15 `verify-*.mjs` scripts and the hardcoded-Chrome pixel-diff pipeline (`toHaveScreenshot`). _M–L / High_
- **Coverage** (`@vitest/coverage-v8`, soft gates on rules/review/scope) + **rules golden-corpus check in CI** (`rules:snapshot:check`). _S / Med–High_
- **Distribution**: portable zip with bundled Node runtime + prebuilt `dist/` (kills the "install Node → npm install → build" first run), then Tauri sidecar or Electron for installers/auto-update/macOS-Linux parity. Quick wins meanwhile: `npm ci` in `start.bat`, Node version check, `start.sh`. _M–L / High_
- **DX**: `npm run verify` aggregate; extract shared CDP helper. _S / Med_
- Not recommended: PWA (loopback app gains nothing); monorepo split (no gain at this size).

---

## 10. Confirmed bugs & rough edges (all file-referenced)

### Correctness / data

1. **Export silently drops EVENT objects** — `server/db/import-export.ts:294–345`.
2. **Non-deterministic, O(n²) dump pagination** — `LIMIT/OFFSET` without ORDER BY; concurrent writes skip/duplicate rows — `import-export.ts:465–468`.
3. **SSE frame dropping corrupts AI streams** — while backpressured, `send()` drops frames instead of queueing; a stalled tab receives answers with missing chunks — `server/sse.ts:89–99`.
4. **Practice grading unfairness** — masked-then-string-canonicalized comparison: aliased sensitive columns flip verdicts; DECIMAL/BIGINT strings `12.30` ≠ `12.3` — `server/db/query.ts:383–390` → `server/db/practice.ts:125–159`.
5. **MySQL EXPLAIN ANALYZE runtime data never reaches findings** — stored only as unparsed text; `slow-node`/`slow-runtime` are dead rules on MySQL — `server/db/explain.ts:427–445, 273–295`.
6. **SHOW WARNINGS unreachable for SELECTs** — `header` is null for row-returning statements so `warningStatus` is always 0 — `server/db/query.ts:201–207, 363–364`.
7. **Slow-log entries merge on MariaDB** — splitting on `/# Time: /` breaks when the line repeats — `server/db/metrics.ts:197`.
8. **Audit re-admits system schemas** — if the SYSTEM_SCHEMAS filter empties the list, the filter is undone — `server/review/audit.ts:186–191`.
9. **Duplicate-attempt grading drift** — byte-identical resubmissions return stored evaluations without marking them stale after data changes — `server/ai/practice.ts:547–555`.

### Frontend

10. **Assistant "Insert into editor" wipes the buffer** — replaces the whole tab SQL instead of inserting at caret (`insertText` already exists) — `src/pages/WorkspacePage.tsx:1158` vs `:302–313`.
11. **Conversation persistence effect contradicts its own comment** — `history` in the dep array re-arms the debounced PUT on every keystroke, postponing persistence indefinitely — `src/components/AiAssistant.tsx:181–209`.
12. **Ctrl+T cannot work** — browsers reserve it; `preventDefault` doesn't stop a new browser tab — `WorkspacePage.tsx:803–815`.
13. **Duplicate `practiceSets` fetch on mount** — `src/pages/PracticePage.tsx:534–544` and `:704–710`.
14. **Lint diagnostics are whole-line** — every finding maps `from: line.from, to: line.to`; empty-line fallback can bleed a char — `src/components/SqlEditor.tsx:186–197`.
15. **Cancelled AI review hides partial output** — `aiRaw` renders only while `ai` is truthy — `src/components/ReviewPanel.tsx:477–486`.
16. **History capped at 150, older entries unreachable** — `src/lib/db-api.ts:227–231` + in-memory filter in `WorkspaceModals.tsx:47–52`; "Clear history" is one unscoped click.
17. **Palette keyboard gaps** — no ArrowUp/Down wrap, Home/End/PageUp unhandled, no scroll-into-view — `CommandPalette.tsx:225–237`.
18. **Schema tree hard cut at 400 tables** — `SchemaSidebar.tsx:345, 406–408`.
19. **Pagination claims full counts when truncated** — `ResultsGrid.tsx:155, 172, 298–324`.
20. **Editor theme flag hardcoded `dark:true`** — `SqlEditor.tsx:72`.

### Security (low severity, cheap fixes)

21. **Non-constant-time master token comparison** — `server/index.ts:264`.
22. **No CSP header** — `server/index.ts:114–118`.
23. **In-memory login throttle resets on restart** — `server/routes/auth.ts:53`.
24. **AI spend unbounded per member** — `server/routes/ai.ts:254–256`.

---

## 11. Suggested sequencing

**Horizon 1 — Trust & quick wins (≈1–2 weeks)**
Grading-fairness fixes (numeric tolerance, mask-safe diffing) · assistant insert-at-caret · cancelled-stream retention · EXPLAIN ANALYZE parsing + drift finding · keyset dump + EVENT export · SSE frame queueing · duplicate fetch · Ctrl+T · Node `engines` + CI build step + windows matrix + secret-scan step · CSP + `timingSafeEqual` · side-by-side result diff (starts Theme A).

**Horizon 2 — The learning loop & the grid (≈3–6 weeks)**
SQL Lab: SRS review queue, daily challenge + streaks + dashboard, hint ladders, multiple accepted solutions, mastery map · results grid: sort/filter, cell inspector, copy-as formats, charting · editor: snippet completions, run-script mode, hover tooltips · diagnostics: digest enrichment, lock waits · AI: usage accounting + budget + prompt caching + structured output · history v2 + schema explorer v2.

**Horizon 3 — Strategic (quarter-scale)**
Portable/Tauri distribution · Playwright e2e + visual regression replacing the CDP harness · schema diff/migration generation · AI-independent practice pattern library · ERD view · streaming results end-to-end · Express 5 + Vitest 4 + Zod 4 migrations · i18n extraction when the audience warrants it.

---

## 12. Sources

**Frontend/editor research**: PopSQL vs TablePlus (slashdot.org) · DBeaver data viewing/filters docs (dbeaver.com) · TablePlus docs (Copy Rows As, Quick Look) · CodeMirror 6 refs & examples (codemirror.net) · marimo-team/codemirror-sql · DataLemur questions page.

**Backend/MySQL research**: Oracle MySQL blog (JSON EXPLAIN) · PlanetScale EXPLAIN ANALYZE · MySQL 8.4 perf-schema statement summaries · MariaDB ANALYZE FORMAT=JSON / EITS / sys schema / ANALYZE for statements · MySQL 8 data_locks/data_lock_waits (+ lefred.be) · mysql2 docs (stream, execute) · MariaDB vs MySQL incompatibilities.

**SQL Lab competitive research**: datalemur.com (+ questions page) · LeetCode SQL 50 study plan (+ "any order" judge convention) · stratascratch.com · hackerrank.com SQL domain + scoring · sqlbolt.com · sqlzoo.net · mode.com window-function tutorials · sql-practice.com · db-fiddle.com / sqlfiddle.com · spaced repetition for problems (sive.rs/srs, HN thread 40173237, r/leetcode) · Duolingo streak design research (blog.duolingo.com) · advanced-SQL topic coverage guides.

**Platform research**: Express 5 migration guide (+ issue #5944) · Node release/EOL schedules (nodejs.org, endoflife.date) · Vitest 4 announcement + migration guide · mysql2 advisories (GHSA-3f6p-5ww8-9rcr) · Express CVE history · Zod v4 + subpath strategy · React 19.2/CVE-2025-55182 + React Router 7 changelog · Vite Rolldown/Vite 8 (vite.dev) · Tauri sidecar pattern (tauri.app, aptabase.com).
