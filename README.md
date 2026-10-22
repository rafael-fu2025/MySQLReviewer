# MyLens — MySQL Review Studio

A local-first MySQL/MariaDB review app for your XAMPP server. It connects to your running database, lets you explore every schema object, run safe queries, inspect EXPLAIN plans, audit schema/security/performance, and get a second opinion from any AI provider you configure. It also includes **SQL Lab**, a reviewer-style practice mode that generates schema-grounded challenges and grades your answers against the real database.

> Read-only by default. Writes require typing `UNLOCK WRITES` for a 15-minute per-connection window, and destructive statements need a second confirmation.

![MyLens](https://img.shields.io/badge/local--first-yes-2dd4a7) ![MySQL](https://img.shields.io/badge/MySQL-5.7%20%7C%208.x-ff8a3d) ![MariaDB](https://img.shields.io/badge/MariaDB-10.x-ff8a3d)

## Quick start

### One click

Double-click **`start.bat`**.

It installs dependencies if needed, builds the UI if needed, opens `http://127.0.0.1:8787`, and starts the local server.

### Development

```bash
npm install
npm run dev
```

- UI: `http://127.0.0.1:5174`
- API: `http://127.0.0.1:8787`

### Production-style

```bash
npm install
npm run build
npm start
```

Open `http://127.0.0.1:8787`.

### XAMPP

A **XAMPP (local MariaDB)** profile is seeded on first run with `root@127.0.0.1:3306` and an empty password. Start MySQL in the XAMPP control panel, open the app, and click **Connect**.

The app detects `C:\xampp` and `%USERPROFILE%\xampp` and shows the detected path/port on the connect screen. It does **not** auto-connect until you choose the profile.

## Features

### Connections

- Multiple connection profiles, optional database, socket path, and TLS.
- Passwords encrypted at rest with AES-256-GCM, or session-only if you prefer not to save them.
- Test connection with server version, flavor, latency, uptime, and the database list.
- **Database scope:** use all databases or restrict a profile to an allowlist. Scoped profiles hide out-of-scope schemas and reject out-of-scope queries, schema reads, table data, reviews, and audits. Server-wide Performance/Security pages are disabled unless you opt in.
- **Least-privilege GRANT helper:** generate reviewable `CREATE USER` / `GRANT` SQL for a dedicated account. MyLens never executes account changes; MySQL grants remain the real security boundary.
- Friendly errors for refused connections, access denied, missing databases, parse errors, and timeouts.
- Automatic MySQL/MariaDB version detection and feature gating.

### SQL workspace

- CodeMirror 6 editor with MySQL syntax highlighting, schema-aware autocomplete, formatter, and live lint.
- Multiple tabs, query history, and saved snippets.
- `Ctrl+Enter` run, `Ctrl+Shift+Enter` run selection, `Ctrl+Shift+R` review.
- Result grid with typed cells, binary/JSON/NULL rendering, pagination, copy, CSV/JSON export, and row-cap/timeout indicators.
- Credential-like columns (`password`, `token`, `secret`, `api_key`, and similar names) are masked before results reach the browser. **Reveal values** asks for confirmation.
- Server-side statement timeout (`max_statement_time` on MariaDB, `max_execution_time` on MySQL) and result cap (`sql_select_limit`).
- Command palette (`Ctrl+K`) for navigation plus actions: create a database, toggle the sidebar, and run/explain/review the current statement.
- Persisted layout: collapse the sidebar or schema rail, drag the editor/results split, and maximize results (Escape restores).

### EXPLAIN and Review

- Normalized plan tree with access types, keys, rows, filtered %, cost, and extra flags.
- Runtime `ANALYZE` on MariaDB (`ANALYZE FORMAT=JSON`) or MySQL (`EXPLAIN ANALYZE`).
- Plan insights: full scans, filesort, temporary tables, join buffers, missing indexes, bad filter ratios, high costs.
- **50+ deterministic rules** across:
  - Correctness and data safety
  - Query performance
  - Schema and index design
  - Account/privilege security
  - Server configuration
  - Explain-plan and telemetry checks
- Weighted score with per-category caps, A–F grade, severity filters, and line-level navigation.
- Index advisor that derives composite candidates from equality/range/join/ORDER BY usage and existing index prefixes.

#### Rule engine

Rules are declarative descriptors rather than inline conditionals:

```ts
defineRule(
  {
    id: 'sql.select-star',
    title: 'SELECT * returns every column',
    severity: 'low',
    category: 'performance',
  },
  ({ ast, line }) => (isSelectStar(ast) ? { message: '…', recommendation: '…', line } : null),
);
```

Every rule declares its id, title, severity, and category in one place, and
returns the findings it produced (or nothing when it does not apply). The
engine collects them, applies the rule's defaults, and scores the result.
`RULE_CATALOG` in `server/review/rules/registry.ts` enumerates every rule with
its metadata, so the rule set can be documented, listed, or filtered without
touching the rule implementations.

### Database explorer

- Databases, base tables, views, routines, triggers, and events.
- **Create database** with a validated name, charset, and collation. This is DDL: it requires an unlocked connection and runs one statement that cannot be rolled back.
- Table overview: estimated rows, data/index size, fragmentation, engine, collation, checks, partitions.
- Columns, indexes (with duplicate/redundant flags), foreign keys, referenced-by relationships, triggers, and DDL.
- Safe data preview with column/operator filters, sorting, page size, export, and masked credentials.
- Relationship mini-map for the selected table and its FK neighbors.
- Definition viewer for views, routines, triggers, and events.

### SQL Lab

- Choose a database, tables, topics (select, joins, aggregation, subqueries, CTEs, window functions, set operations, DML, DDL, indexes, transactions, schema design, security), difficulty, and challenge count.
- AI generates reviewer-style prompts grounded only in the selected schema: write-a-query, fix-a-query, review-a-query, and concept/design tasks.
- Executable reference SQL is validated as a single read-only, non-locking statement before a challenge is accepted.
- Submit an answer and get a verdict with correctness, performance, and style scores.
- Read-only SELECT answers are executed and compared with the reference by column count, row multiset, and ordering when required. Wrong rows, extra rows, and wrong ordering are shown explicitly.
- DML/DDL/concept answers are graded from the written answer and **never executed**.
- Every evaluation includes static rule findings, EXPLAIN insights, an optional AI explanation, progressive hints, and a reference solution.
- Progress panel tracks per-topic attempts, average, best score, and recommends the weakest or least-practiced topic.

### Performance

- Live snapshot every 5 seconds: QPS, threads, connections, buffer-pool hit ratio, slow queries, full joins, temp-table spills, aborted connects, uptime.
- Sparklines from recent samples.
- Process list with optional kill (requires unlock + confirmation).
- Slow-query digests from `performance_schema` when available, slow-log parsing when enabled, and exact enable guidance when both are off.
- Largest tables, replication status, and a searchable variables explorer.

### Security

- Account inventory with host patterns, auth plugins, and password-set status.
- Privilege flags and effective grants (never password hashes).
- Findings for anonymous users, empty passwords, remote root, wildcard hosts, excessive privileges, weak plugins, and invalid definers.
- Server configuration checks: `local_infile`, `secure_file_priv`, `bind_address`, `sql_mode`, `skip_name_resolve`.
- Coverage reporting for denied or unsupported checks.

### Full audit

- Select one or many databases and run schema, security, config, and performance checks.
- Live progress over SSE, coverage transparency, grouped findings, score, environment snapshot, and audit steps.
- Optional AI executive summary.
- Save reports and export Markdown, standalone HTML, or JSON.
- Handles schemas that disappear mid-audit without failing the run.

## AI checker

Configure providers in **Settings → AI providers**.

Built-in presets:

- OpenAI
- OpenRouter
- DeepSeek
- Groq
- Anthropic (native Messages API)
- Google Gemini (native API)
- Ollama (local)
- LM Studio (local)
- Any custom OpenAI-compatible endpoint (base URL, chat path, models path, auth header/prefix, custom headers, extra body)

The AI review receives only what you choose:

- the SQL
- referenced table/column/index/FK context
- deterministic findings
- optional EXPLAIN plan

It returns a structured verdict, score, findings, and an optional rewrite. Responses stream into the UI, and the rewrite is never executed automatically.

SQL Lab uses the selected provider in two places: generating challenges from the chosen schema, and optionally explaining an answer after deterministic grading. Sample rows are off by default; when enabled they are capped, masked, and separated from instructions.

**Privacy:** no telemetry, no hidden calls. Cloud providers are contacted only when you click **Deep review**, **Run audit with AI**, generate SQL Lab challenges, request AI feedback, or use AI chat. Local providers such as Ollama/LM Studio keep data on the machine.

## Interface

- **Responsive from 360px up.** On phones the icon rail is replaced by a bottom navigation bar with 48px touch targets, with the less common sections behind a “More” sheet. The topbar wraps the database picker onto its own row so the page title and every control stay reachable, and the database explorer stacks its object tree above the table detail.
- **Contrast.** Every color token passes WCAG AA against every surface in both the dark and the light theme.
- **Keyboard and screen readers.** Dialogs trap focus, close on Escape, restore focus on exit, and cap their height so the body scrolls. The editor/results splitter is a `separator` with pointer, arrow-key, Home/End, and PageUp/PageDown support.
- **Motion.** Animations are suppressed when the OS requests reduced motion; the spinner and progress indicator keep running because they report live state.
- **Type.** No text renders below 10px; secondary metadata sits at 10–11px against a 14px base.

## Safety model

- API binds to `127.0.0.1` by default.
- Host header and Origin checks, plus a per-boot API token required on all non-bootstrap requests.
- No CORS.
- `multipleStatements: false`; only one statement executes at a time.
- Conservative SQL classifier blocks DML/DDL/admin/locking reads in read-only mode.
- Typed `UNLOCK WRITES` confirmation, 15-minute TTL, immediate re-lock.
- Destructive statements require a second acknowledgement with a statement preview.
- Database scope is a workflow guardrail, not a security boundary. Another client using the same MySQL credentials can still reach other databases. Use the GRANT helper with a dedicated restricted user for real isolation.
- Scoped profiles block out-of-scope schema/table/data routes, qualified cross-database references, `USE`, `SHOW DATABASES`, and `SHOW PROCESSLIST`.
- SQL Lab executes only validated read-only SELECTs. DML, DDL, and concept answers are graded without execution.
- Sensitive-column masking is name-based and best-effort; it does not replace database grants.
- AI-generated SQL is never executed automatically. Schema/table comments and sample values are treated as data, and prompts explicitly ignore instructions found inside them.
- Practice sample data is opt-in, capped, and masked.
- Passwords and AI keys encrypted with AES-256-GCM using a local key in `data/.secret.key`.
- Secrets are never returned to the browser; profiles expose only hashes hints/flags.
- Logs avoid request bodies and credentials.

## Project layout

```
shared/              Shared API and DTO types
server/
  db/                MySQL manager, dialect, safety, scope, masking, create-database,
                     grant SQL, introspection, query, explain, metrics, practice grading
  review/            Lexer, classifier, rules, scoring, context, index advisor, audit, reports
  ai/                OpenAI-compatible, Anthropic, and Gemini adapters + prompts + streaming
  store/             Atomic JSON store, AES-GCM crypto, profiles, providers, history,
                     snippets, reports, practice sets/attempts
  routes/            REST + SSE endpoints
  index.ts           Express bootstrap and local security middleware
src/
  components/        UI primitives, combobox, findings, editor, results, review, audit, dialogs
  pages/             Connect, Workspace, Database, SQL Lab, Performance, Security,
                     Audit, Reports, Settings
  lib/               API client, SSE parser, formatting, events, statement client
  store/             Zustand app/workspace/UI-layout state
tests/               Vitest unit tests (115 tests)
scripts/smoke.ts     Read-only live verification against local MySQL/MariaDB
scripts/rule-snapshot.ts  Rule-engine characterization snapshot (see Verification)
scripts/ui-layout/   Headless-Chrome layout check across viewport widths
```

## API overview

- `GET  /api/bootstrap` — app info, token, profiles, providers, settings, XAMPP detection
- `GET  /api/health`
- `POST /api/connections/test`, CRUD `/api/connections`
- `POST /api/connections/:id/connect|disconnect|unlock|lock`
- `POST /api/connections/:id/grant-sql` — returns SQL for review; never executes it
- `GET  /api/db/:id/databases`, `/charsets`, `/objects`, `/schema`
- `POST /api/db/:id/databases` — create a database (requires unlock)
- `GET  /api/db/:id/databases/:db/tables/:table`
- `POST /api/db/:id/databases/:db/tables/:table/data`
- `POST /api/db/:id/query`, `/explain`, `/kill`
- `GET  /api/db/:id/performance|variables|status|security`
- `POST /api/review/static`, `/review/ai` (SSE), `/review/save`
- `POST /api/practice/generate` (SSE), `/practice/evaluate`
- `GET  /api/practice/sets|attempts|progress`; `DELETE /api/practice/attempts`
- `POST /api/ai/providers`, `/providers/:id/test|default`, `/ai/chat` (SSE)
- `POST /api/audit/run` (SSE)
- `GET  /api/reports`, `/reports/:id`, `/reports/:id/export?format=md|html|json`
- `GET/DELETE /api/history`, CRUD `/api/snippets`, GET/PUT `/api/settings`

## Data and configuration

Runtime data lives in `data/` (gitignored):

- `profiles.json` — connection profiles (secrets encrypted, scope allowlists)
- `providers.json` — AI provider configs (keys encrypted)
- `settings.json` — theme, limits, masking, defaults
- `history.json`, `snippets.json`
- `practice.json` — SQL Lab sets and attempts (capped)
- `reports/*.json`
- `.secret.key` — generated AES key; back it up if you want to keep saved secrets

Environment overrides:

- `MYLENS_PORT` (default `8787`)
- `MYLENS_HOST` (default `127.0.0.1`; keep it loopback)
- `MYLENS_DATA_DIR`
- `MYLENS_DEBUG=1` for stack traces

## Verification

```bash
npm test          # 115 unit tests
npm run typecheck
npm run lint      # eslint --max-warnings 0
npm run format:check
npm run build
npm run smoke     # read-only live check against local MySQL/MariaDB
```

The live smoke test defaults to `root@127.0.0.1:3306` with no password. Override with `MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_USER`, `MYSQL_PASSWORD`, `MYSQL_DATABASE`.

### Rule engine snapshot

`npm run rules:snapshot` runs every rule module over a fixed corpus of SQL,
schemas, accounts, and server settings, and prints a normalized JSON snapshot
of the findings. Use it to prove that a change to the rule engine did not
alter what the rules report:

```bash
npm run rules:snapshot > before.json
# … change the rules …
npm run rules:snapshot > after.json
diff before.json after.json
```

The corpus exercises all 111 rules, so an empty diff means the rule set, the
messages, and the severities are unchanged.

### Layout check

`npm run ui:layout` renders the app shell in headless Chrome at seven viewport widths (360 → 1440) and reports whether any control is clipped, crushed, or overflowing its container. It needs a Chrome/Edge install; set `CHROME_PATH` if it is not in the default location.

`npm run ui:shots <label>` screenshots the running app (`npm start`) at desktop and phone widths, with the clock frozen and animations disabled so two captures of the same build are byte-identical. `npm run ui:diff <a.png> <b.png>` then reports how many pixels differ and where. Use the pair to prove a UI change is visually neutral:

```bash
npm run ui:shots before   # before the change
# … change the UI …
npm run build && npm start
npm run ui:shots after
npm run ui:diff .snapshot/before-desktop.png .snapshot/after-desktop.png
```

### Mock AI provider (optional)

To exercise the AI review and chat UI without a real key:

```bash
node scripts/mock-ai.cjs
```

Then add a provider in Settings with base URL `http://127.0.0.1:9999/v1` and model `mock-model`. Remove it when you are done. The mock returns a fixed review JSON and a short chat answer.

## XAMPP / MariaDB notes

The app is tested against XAMPP's **MariaDB 10.4.32** and supports MySQL 5.7/8.x.

On a default XAMPP server you should expect the audit to flag:

- passwordless `root`/`pma` accounts
- `sql_mode` without `STRICT_TRANS_TABLES`
- `local_infile=ON`
- `secure_file_priv=NULL`
- `bind_address` unset (listens on all interfaces)
- slow query log and `performance_schema` off

Those are real findings. The audit score for a development server can therefore be low; that is intentional, and the findings explain what to change. The security page includes a local-development advisory.

MariaDB-specific handling:

- `ANALYZE FORMAT=JSON` instead of MySQL's `EXPLAIN ANALYZE`
- `max_statement_time` session guard
- no reliance on the `sys` schema
- graceful degradation when `performance_schema` or the slow log is unavailable
- transient schemas dropped mid-audit are reported as coverage errors, not fatal failures

## Troubleshooting

**“MySQL refused the connection”** — start MySQL in the XAMPP control panel; confirm port 3306.

**“Access denied”** — edit the profile and enter the password. The seeded profile assumes XAMPP's default `root` with no password.

**Port 8787 already in use** — stop the other process or set `MYLENS_PORT`.

**UI is not built** — run `npm run build`, or use `npm run dev`.

**No slow query data** — enable the slow log:

```sql
SET GLOBAL slow_query_log = ON;
SET GLOBAL long_query_time = 1;
```

`performance_schema` requires a server restart with `performance_schema=ON` in `my.ini`.

**AI provider fails** — use **Test provider** in Settings. Many local servers (Ollama/LM Studio) expect no API key; for custom gateways set the base URL, chat path, auth header, and prefix.

## Out of scope

Automatic MySQL user creation, executing DML/DDL practice answers, backup/restore, replication setup, schema migrations, multi-user accounts, cloud sync, and inline table-data editing. Writes are available through the unlocked SQL editor only.

---

Built for local review work. Verify recommendations before applying them to production data.
