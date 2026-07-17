# NGPCX — ARM Readiness Scanner
Project brief — updated 2026-07-17 (supersedes PROJECT_BRIEF-260705.md; that file is left in place as a historical snapshot, not deleted)

## Overview
NGPCX is an ARM Readiness Scanner for Windows users considering a Snapdragon laptop — consumer-facing brand name **CheckMyARM** (live across every visitor-facing page; NGPCX stays the internal/code name only). Built to scratch the founder's own itch — no equivalent tool exists. Learning project with real utility. Potential affiliate monetization is a bonus, not the goal; Ko-fi donations are live, affiliate links are still a placeholder.

Since the last brief (2026-07-05), the product shape changed from "Scanner → Report" to "Evidence Collection → Guided Assessment → Recommendation → Community Contribution." The scanner is now one of several evidence sources; the assessment (not any single page) is the artifact a user builds, exports, and returns to.

## The components
- **Server** — Node.js + Express, plain JavaScript (no TypeScript), SQLite (better-sqlite3), runs on Railway (auto-deploys from GitHub on push). Now includes Passport-based OAuth (Google + GitHub), a hand-rolled session store, and role-gated admin/researcher/community routes.
- **Scanner** — Rust .exe, runs locally on the user's Windows machine, sends JSON to the server. **Considered feature-complete pending code signing** — five enrichment passes since the last brief (see "Scanner considered feature-complete" below) deliberately closed out scanner scope; further work is on the product/assessment layer, not scanner discovery.
- **Scrapers** — winget + WorksOnWoA (dual source), run locally/on schedule, never on Windows in production. Seed from committed cache atomically on boot.
- **Frontend** — 13 plain HTML/JS pages (no framework), all now sharing one unified, adaptive navigation shell (`nav.js` + `shell.css`) instead of 13 divergently hand-written nav bars.

## Data flow — the assessment lifecycle
```
Browser clicks Run Scan (or Import Assessment, from any page)
  → Creates session on server → downloads ngpcx-scanner.exe
  → Scanner runs, collects apps/devices/system info + Guidance Signals
  → POSTs to /api/scan → server classifies against catalog → session status flips to 'complete'
  → Browser redirects to Results (report.html) — the Initial Recommendation
User optionally opens the Workspace (workspace.html) to refine:
  → Marks Personal Context: "this matters to me," "I don't use this anymore,"
    personally-verified status, notes
  → Nothing on Results changes until the user explicitly clicks Recalculate —
    the one seam between "draft state" and "published Recommendation"
  → Recalculate produces the Updated Recommendation, back on Results
Export/Import (three-layer format) lets a user carry an assessment across
devices/browsers with zero server-side persistence of personal data:
  → observation_snapshot (raw scanner facts) + personal_context (their
    decisions) + assessment_snapshot (a frozen historical comparison)
  → Import re-classifies the observation snapshot against TODAY's catalog,
    so an old export benefits from any catalog improvements since
```
**Scan level** (Light / Standard / Advanced, consumer-facing names for the original `quick`/`standard`/`full` wire values) now has real behavioral differences beyond scan depth: Light curates which apps actually drive the recommendation (via footprint evidence — running, startup, pinned, recently launched) rather than treating every installed app as equally decision-relevant; Standard uses a broader but still real bar; Advanced applies no curation at all.

## Database
8,890 apps total (3,483 native ARM64, 5,401 x64-emulated, 5 unsupported, a handful still genuinely unknown) — modest organic growth from the 8,880 at the last brief, via the scrapers below plus ongoing admin/community resolution. SQLite, seeded from committed cache atomically on boot (a full-transaction seed, not per-row — a real incident early on left the DB in a hung, partially-seeded state before this was fixed).

Schema grew substantially: alongside `apps`, there's now `sessions` (assessment state), `users`/`auth_sessions`/`oauth_states` (OAuth), `community_submissions` (user-reported compatibility findings, anonymous or authenticated), `unknown_apps`/researcher-facing queue tables, `researcher_requests`, and `researcher_recommendations` (the Community Review proposal/confirm workflow).

## Community trust layer & authentication (new since last brief)
- **Anonymous identity**: first community submission gets an HttpOnly cookie identity, no personal data. Submissions dedupe by identity, not scan session.
- **Optional OAuth** (Google + GitHub, now live in Railway production as well as locally): anonymous → authenticated migration on login, three roles (`user` / `researcher` / `admin`), rank-based authorization, live-reads role on every request (a revoked/demoted account loses access on its very next request, no logout needed).
- **Researcher workflow**: a `user` account with 3+ active community submissions gets a volunteer invitation; an Admin approves/declines. Researchers get access to the existing catalog-research tools plus a dedicated **Community Review** workspace (propose a recommendation from community evidence, a second Researcher/Admin confirms or revises it before it touches the catalog — self-review is server-blocked).
- **Admin tooling**: a work-queue dashboard, user/role management, and the pre-existing unknown-app research + stale-verdict revisit tools. A legacy shared-secret admin path still coexists with OAuth (deliberate, long migration window, not yet retired).
- Philosophy carried through: no automated bulk research, no paid search API — humans research and submit verdicts; one narrow automated exception (a low-confidence, conservative GitHub-repo lookup) exists for genuinely unresolved apps only.

## Assessment Workspace & Guidance Signals (new since last brief)
Full design doc: `WORKSPACE.md` (note: that file's own "Status" line reads "Design stage, no implementation yet" — that's now stale; the Workspace has been built and iterated through several rounds since. Treat `CLAUDE.md` as authoritative over `WORKSPACE.md` for current status.)

- **Guidance Signals**: the scanner now observes — beyond "is this installed" — whether an app is currently running, set to start with Windows, launchable from the Start Menu, pinned to the taskbar, a genuinely recent/frequent interactive launch (via Windows' own UserAssist launch history, which specifically excludes non-interactive/background launches), and whether it's the user's actual default browser/mail handler. None of this changes compatibility scoring directly — it changes what the product treats as worth a person's attention.
- **Attention & Background/Reference filtering**: real user feedback (a genuine machine's results) showed Windows platform components and passively-detected software crowding out what a person actually cares about. Fixed with a structural rule — Microsoft-first-party AppX packages and browser-hosted PWAs are background-typed by default, down-weighted in scoring, and grouped separately — unless the user (or real usage evidence) says otherwise.
- **Browser-Hosted (Supported)**: a PWA (Chrome/Edge-installed web app) has no separate ARM64 binary to classify — it used to show as an alarming "Unknown." Now gets its own "Supported" status, scored like a resolved positive fact, with plain-language framing ("runs through your browser, doesn't need a separate ARM64 build").
- **Canonical effective status**: a real consistency bug (badge said "Unknown" next to a note saying "treated as Native") got fixed by making one shared function compute an app's effective status everywhere it's shown or scored — no more drift between what a badge says and what the score assumes.
- **Export/import**: rebuilt into the three-layer format described above (raw observations / personal decisions / a frozen historical snapshot), replacing an earlier decision-only format that couldn't capture scanner evidence.

## Application Shell — navigation redesign (shipped this week)
Replaced ~13 pages' worth of duplicated, hand-written `<nav>` markup with one shared, adaptive shell (`public/nav.js` + `public/shell.css`), rendered against a single placeholder on every page:
- Five logical modes (Assessment, Community, Learn, My Account, Administration) instead of a flat link list, each appearing only when relevant to the current identity and session state.
- The header communicates *context* (who you are, what's active); the page itself still owns the actual assessment/analysis — a hard boundary, not a style choice (the shell never renders a score or confidence label).
- Platform-aware guidance (Windows / non-Windows / unknown, from coarse browser signals) changes which action is emphasized — never what's available.
- A subtle, non-clickable subtitle beneath the logo shows raw evidence counts ("Current assessment based on 171 apps · 10 devices") once a session is active — reinforcing that the recommendation is built from evidence, without turning the header into a second dashboard.
- Found and fixed two real bugs during rollout: dropdown menus staying permanently visually open (a CSS specificity gap), and the header silently losing track of a just-started assessment while the physical scanner was still running (a one-shot session check that never rechecked once the scan actually finished).

## Scrapers
Unchanged in approach from the last brief — `winget.js` (search-based, ARM64 installer detection) and `community/worksonwoa.js` (WorksOnWoA's community database) are the two enabled sources, merged with confidence-based conflict resolution. Windows Update Catalog bulk-scraping remains explicitly rejected (ToS conflict + technical fragility, confirmed via testing, not revisited).

## Scanner design
**Frozen, deliberately, pending code signing** — five focused enrichment passes since the last brief (Scanner Stabilization, Observation Enrichment, Scanner Enrichment, UserAssist Enrichment, Environment Integration Evidence) each added one narrow, validated signal (see Guidance Signals above) and were explicitly scoped to *observation quality*, never scoring or recommendation logic. That scope is now considered complete; further engineering effort is on the assessment/product layer built on top of it, not new scanner discovery. Device detection tiering (Quick/Standard/Full) and app enumeration (now mode-agnostic — every tier returns the full inventory, since the old per-mode filter was found to save no real time) are unchanged in spirit from the last brief.

## File structure (abbreviated — grew substantially)
```
ngpcx/
├── server/
│   ├── server.js, db.js, seed.js, identity.js, passportConfig.js, sqliteSessionStore.js
│   ├── middleware/auth.js       ← role-rank authorization, shared by every gated route
│   └── routes/
│       ├── scan.js, community.js, auth.js, researcher.js, admin.js
│   └── scrapers/                ← winget.js, community/worksonwoa.js, github-lookup.js
├── public/
│   ├── nav.js, shell.css        ← the shared application shell (new)
│   ├── assessment.js, assessment.css  ← shared synthesis/decision/device logic
│   ├── index.html, report.html, workspace.html
│   ├── about.html, why.html, how-it-thinks.html, privacy.html, my-submissions.html
│   ├── admin-dashboard.html, admin-users.html, admin-research.html,
│   │   admin-revisit.html, admin-community-review.html
│   └── ngpcx-scanner.exe        ← committed binary; must be manually rebuilt/republished
│                                    when scanner/src/main.rs changes (a known deploy-hygiene gap)
├── scanner/src/main.rs
├── data/compatibility.db
├── .cache/{winget,worksonwoa}/  ← committed scrape cache, source of truth for reseeding
├── CLAUDE.md                    ← authoritative, continuously-maintained engineering reference
├── WORKSPACE.md                 ← design-philosophy doc; status line is stale, see above
└── PRIVACY_BACKLOG.md
```

## What we are NOT doing
Unchanged: no TypeScript, no Next.js, no React, no Tailwind, no running the scanner from the web server, no running scrapers on Windows, no bulk-scraping the Windows Update Catalog. New additions to this list: no further scanner discovery-scope expansion (see "Scanner design" above); no leaderboards, public profiles, or contributor reputation scores; no assessment-history feature (no "My Assessments" list — a user was explicit that nothing should be invented here to fill a UI gap); no automated/AI-assisted research.

## Infrastructure
- GitHub: https://github.com/erictriumph/ngpcx (auto-deploys to Railway on push)
- Hosting: Railway. **A persistent Volume is now provisioned and mounted** (`ngpcx-volume` at `/data`, `DATA_DIR` env var) — the database no longer lives on Railway's ephemeral build directory, which was the default before this was caught and fixed.
- Domain: ngpcx.com → Cloudflare → Railway. The scanner's hardcoded server URL stays `ngpcx.com` regardless of any future branding change, since already-distributed exes can't be updated.
- OAuth is **enabled in Railway production**, not just locally, after full verification against real Google/GitHub providers and a volume-persistence pre-flight.
- Local dev unchanged: Windows, VS Code, D:\projects\ngpcx, Node, Rust.

## Code signing & distribution decisions
Unchanged since the last brief — still pending, still the one concrete blocker before wider distribution:
- **Signing: Azure Trusted Signing**, ~$10/month vs. $200-400/year for a traditional OV cert. Requires a personal Azure identity separate from the founder's employer credentials — verification was pending as of the last brief; status not advanced since.
- **Distribution: direct .exe download stays the primary path/CTA.** Microsoft Store (MSIX) remains secondary/optional, not the front door.

## Known issues / next priorities
- Code signing — see above, the main outstanding item.
- The public scanner.exe has drifted stale before (once, caught and fixed) because nothing automatically rebuilds/republishes it when scanner source changes — still a manual step, still a known gap worth closing before signing.
- `about.html` still has no personal "who's behind this" author bio — deliberately deferred pending the founder's own wording.
- A dedicated "Understanding Your Results" educational page (the report-specific companion to the more general `why.html`) is scoped but not built — explicitly deferred, do not build without being asked.
- The legacy shared-secret admin path (`ADMIN_SECRET`) still coexists with OAuth — a deliberate, not-yet-finished migration window.
- An "ARM Optimization Workspace" (reframing the product for someone who *already* bought an ARM PC, to help them verify/optimize it) is a well-scoped future idea, hard-blocked on not having real ARM64 hardware to build and test against. Parked, not started.
- `WORKSPACE.md`'s own status line needs a correction pass — it currently misrepresents the Workspace as unbuilt.

## Local dev testing flow
```
Start server: node server/server.js
Open localhost:3000, select an assessment level, click Run Scan
Run: cargo run --manifest-path scanner/Cargo.toml -- --standard --local
Browser auto-redirects to Results
```

## Scraper commands
```
npm run scrape             — runs all enabled scrapers (Winget + WorksOnWoA)
npm run scrape:winget -- --letters=g,m
npm run scrape:woa
```
