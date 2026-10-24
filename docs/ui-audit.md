# MyLens UI audit

**Date:** 2026-10-24
**Scope:** the whole front end — all eight routes, light and dark themes, desktop (1440×900) and
phone (390×844).
**Method:** the app was run against a live local MariaDB 10.4.32 (`northwind`), connected through
the real connect flow, then every route was captured in both themes at both widths with a
headless-Chrome/CDP sweep modelled on the repo's own `scripts/ui-layout/app-shots.mjs`. Each
finding was then traced back to source before anything was changed. 32 before-captures and 32
after-captures were compared.

---

## Verdict

**This interface is not AI slop, and the audit did not turn it into anything else.**

The visual identity is specific and deliberate: a near-black canvas (`#080a0f`) with a grid
overlay and two radial washes, a single ember accent (`#ff8a3d`) with mint as the secondary, a
mono face for anything machine-generated, and a flat "instrument panel" treatment for data
surfaces. The radius scale is coherent (5→18px), there is exactly one shadow idiom, and the
status bar, editor chrome and sidebar read as one system. None of the three common AI-generated
looks — cream/serif/terracotta, near-black/acid-green, or broadsheet-hairline — are present, and
none of the cheap markers are either: no emoji anywhere in `src/`, no gradient text, no
`hover:scale`, no `animate-pulse`, and no glassmorphism.

What the sweep did surface was a smaller, more specific class of problem: **consistency and craft
defects**, where one part of the app was built to a different standard than the rest. That is the
kind of thing that reads as machine-generated even when the design is good — the impression comes
from repetition and near-misses, not from a template.

Eleven findings were confirmed and fixed. One further issue is a product decision, not a defect,
and is left alone and written up below.

---

## What the design already gets right

Worth recording, because these are the parts any future change should not undo:

- **One accent, used sparingly.** Ember appears on the active nav item, the primary action, the
  brand mark, and genuine warnings. Nothing is accented for decoration.
- **A real radius scale.** `--radius-*` tokens resolve to a fixed ladder; there is no ad-hoc
  `rounded-2xl` scattered through the markup.
- **Dense, machine-like typography.** `Cascadia Code` carries every number, identifier and
  timestamp, which is what makes the UI read as an instrument rather than a website.
- **Honest empty states.** Each one names what is missing and what to do about it.
- **The mobile story was already thought through.** A bottom nav replaces the icon rail below
  640px, the editor wraps instead of scrolling sideways, and the bottom sheet is a real sheet.

---

## Findings, fixed

Severity is about how much damage the defect does to the user's ability to read the screen.

### 1. The page name was stated twice, in two different sentences — _High_

The shell top bar printed the page name and a description, and the page body printed the same
name and a _different_ description. On the Performance page the top bar said "Live server
telemetry, processes, slow queries, and variables." while the body said "A live snapshot of server
throughput, sessions, slow work, and configuration." Two names, two descriptions, one screen.

On a 390px phone this repeated block cost about 90px of an 844px viewport — roughly a tenth of
the screen spent saying what page you were on.

_Fix:_ the top bar is now a context-and-controls strip. Pages that declare their own heading say
their name once, in the body; pages that do not (Workspace, Database) keep a top bar label.
`src/components/AppShell.tsx:86` (`SELF_TITLED_ROUTES`), `:153` (`showMeta`), `:344`.

### 2. One stat row mixed two different tile designs — _High_

On the Performance page the first two tiles were wrapped in `<Card>` while the other six were bare
`StatCard`. The two surfaces differ in radius (14px vs 11px), border colour and fill, so the first
row visibly changed halfway across. Worse, CSS grid stretches every tile in a row to the tallest,
so the six flat tiles inherited the height of the two chart tiles and sat with about 70px of dead
space underneath their content.

_Fix:_ all eight tiles are now the same tile, and the two trend charts moved into their own
"Throughput trend" panel. `src/pages/PerformancePage.tsx:325`.

### 3. Chart tiles reserved an empty band before any data arrived — _Medium-High_

The sparkline placeholder was a bare `<div className="h-[42px]" />`, so a tile with no samples yet
rendered a 42px hole. On a phone that hole was a third of the tile.

_Fix:_ the placeholder is now a flat baseline, and the panel only appears once there are samples to
draw. `src/pages/PerformancePage.tsx:39`.

### 4. The brand lockup wrapped — _Medium_

"MySQL Review Studio" shares the sidebar's first row with the mark, the wordmark and the collapse
toggle, which left the tagline about 116px. It wrapped onto two lines in both themes.

_Fix:_ the lockup is a grid. The mark, wordmark and toggle share row one; the tagline spans the
full width on row two and always sets on one line. `src/index.css:217`, `:261`.

### 5. Stat rows broke into ragged shapes — _Medium_

`.stat-grid` used `repeat(auto-fit, minmax(160px, 1fr))`, so the column count was decided by
available width and had nothing to do with how many tiles there were. The Database page's six
tiles rendered as four plus two, with a hole beside the last two.

_Fix:_ explicit column counts that divide the tile count evenly. `.stat-grid-4` and `.stat-grid-6`
in `src/index.css:1366`, applied at `src/pages/DatabasePage.tsx:665`, `:1494`,
`src/pages/WorkspacePage.tsx:85`, `src/components/ExplainPanel.tsx:52`.

### 6. A list cut a row through the middle of the text — _Medium_

The Audit page's database list is capped at 420px, and the cut landed through the glyphs of
`humus_inventory_20260116_validation_test`. It read as a rendering fault rather than as "there is
more below".

_Fix:_ the cut edge is masked so it fades out. `src/index.css:1390` (`.scroll-fade-bottom`),
`src/pages/AuditPage.tsx:367`.

### 7. The phone bottom bar had a muddy brown blob — _Medium_

The active item carried a 12% ember wash over the canvas, which measured `#291f1c` — a brown
block, and the loudest thing in a 61px bar. It also pointed at a _menu_ rather than a destination.

_Fix:_ the active state is now the ember label plus a short rule above the icon, on a flat bar.
`src/index.css:2788`.

### 8. Empty states floated in the top third — _Medium_

`.empty` is `padding: 44px 20px` in normal flow inside a page block with no height, so on a tall
viewport the Reports empty state sat at the top with roughly 440px of void beneath it.

_Fix:_ `.page-centered` lets the block take the full scroll height and settle in the middle.
`src/index.css:466`, `src/pages/ReportsPage.tsx:122`, `src/pages/PracticePage.tsx:843`.

### 9. Three enabled buttons looked disabled — _Medium_

Format, Snippets and History used the ghost variant, whose resting colour is the same muted grey
that disabled buttons fade to — and with no fill or border of their own they read as inert, sitting
in the middle of a row of bordered secondary buttons.

_Fix:_ the editor utilities now have their own group, separated by a rule, and their resting
colour is lifted. `src/pages/WorkspacePage.tsx:868`, `src/index.css:1135`.

### 10. Two orange buttons for the same action, with different names — _Medium_

SQL Lab showed "Generate challenges" in the page header and "Generate a challenge set" in the
empty state. Same action, two names, two competing primary buttons on one screen.

_Fix:_ one name everywhere, and only one primary. The header keeps a secondary shortcut; the
empty state owns the primary action. `src/pages/PracticePage.tsx:896`, `:1217`.

### 11. Hours were printed as minutes — _Low-Medium_

`formatDuration` had no tier above a minute, so a 34-hour uptime printed as **"2072m 41s"**.

_Fix:_ seconds, minutes, hours and days tiers, each rounding once so a carry can never reach 60.
`src/lib/format.ts:18`, covered by the new `tests/format.test.ts`.

---

## Left alone, on purpose

**The Database page shows the same eight tables twice.** The schema sidebar lists every table with
its row count, and the "TABLES" grid immediately to the right repeats the same names with the same
counts plus engine and size. The table count itself appears three times (the sidebar badge, the
stat tile, and the grid badge).

This is the clearest remaining piece of duplication in the app, but it is a _product_ decision, not
a defect: the sidebar may well be intended as a navigator and the grid as the inventory surface,
in which case the fix is to give them different jobs — names only in the tree, metrics only in the
grid. Choosing which one loses information is not an audit's call, so it is written up rather than
made.

Two smaller observations, also left alone:

- SQL Lab presents its identity two different ways — a `PageHeader` when no challenge set is open,
  a compact in-app toolbar when one is. Defensible as "workspace chrome versus page chrome", but
  worth a deliberate decision.
- `/reports/:id` keeps a top bar label reading "Report" while the report's own error states also
  print a "Report" heading. Only reachable in the error path, so it was left as is.

---

## Verification

Run against the live app, not inferred:

| Check                      | Result                                                                     |
| -------------------------- | -------------------------------------------------------------------------- |
| `npm run typecheck`        | pass                                                                       |
| `npm run lint`             | pass (`--max-warnings 0`)                                                  |
| `npm run format:check`     | pass                                                                       |
| `npm run build`            | pass                                                                       |
| `npm test`                 | pass — 21 files, 127 tests (119 pre-existing + 8 new for `formatDuration`) |
| Before/after capture sweep | 32 captures per pass, all 8 routes × 2 themes × 2 viewports                |

Every finding above was confirmed in a rendered capture before it was changed, and confirmed
again in the after-capture. The fixes that are visible in a screenshot — the brand lockup, the
uniform stat row, the single page title, the masked list edge, the centred empty state, the
bottom bar — were checked against both a 1440px and a 390px render.

The two narrow-sidebar paths were checked separately, because the brand-grid change touches both
and the main sweep never exercises either:

| Path                             | How it collapses                   | Verified                                       |
| -------------------------------- | ---------------------------------- | ---------------------------------------------- |
| User's own collapse toggle       | `.sidebar-collapsed` class         | 76px wide, single-column brand, tagline hidden |
| Viewport between 641px and 900px | the `max-width: 900px` media query | 76px wide, single-column brand, tagline hidden |

Measured in the browser rather than eyeballed: `grid-template-areas` resolves to `"mark" "toggle"`
in both, and `.brand-sub` computes to `display: none`.

---

## Re-running the sweep

The audit harness lives outside the repo (it is a diagnostic, not a project artefact). The shape of
it is in `scripts/ui-layout/app-shots.mjs`: launch headless Chrome with a remote debugging port,
drive it over CDP, set the theme with `document.documentElement.dataset.theme`, and change the
viewport with `Emulation.setDeviceMetricsOverride` rather than reloading, so the client-side
connection survives the sweep.

One trap worth recording: a fresh page load drops the active connection, because it lives in the
client store and `/api/bootstrap` returns an empty `activeProfileId`. Navigate once, connect
through the UI, then move between routes by clicking the sidebar's own `NavLink` anchors so the
session survives.

---

## A note on the working tree

`src/pages/PracticePage.tsx`, `src/index.css`, `src/lib/db-api.ts`, `src/store/app-store.ts`,
`src/components/SchemaSidebar.tsx` and `server/routes/practice.ts` already had uncommitted work in
the tree when this audit started. Those diffs are not the audit's — only the changes described
above are.

One side effect is worth flagging: running the repo's own `format:check` fix
(`prettier --write src/pages/PracticePage.tsx`) also normalised the formatting of the pre-existing
edits in that file, which is why its diff is much larger than the three lines the audit actually
touched. The committed version of the file is Prettier-clean, so the drift was introduced by the
in-progress work, and CI would have failed `format:check` without this.
