Continuing the NGPCX ARM Readiness Scanner project. Here's the current project brief:
Project: NGPCX — ARM Readiness Scanner for Windows users considering a Snapdragon laptop. Built to scratch the founder's own itch — no equivalent tool exists. Learning project with real utility. Potential affiliate monetization (laptop recommendations) is a bonus, not the goal.
The 3 components:

Server — Node.js + Express, plain JavaScript (no TypeScript), SQLite database, runs on Railway (auto-deploys from GitHub on push)
Scrapers — Run locally or on a schedule, never on Windows in production
Scanner — Rust .exe, runs locally on user's Windows machine, sends JSON to server, displays report in browser

Data flow:
Browser clicks Run Scan
  → Creates session on server
  → Downloads ngpcx-scanner.exe
  → Polls localhost:7878 passing session ID
User runs scanner
  → Scanner listens on localhost:7878 (20 second timeout)
  → Browser connects, passes session ID
  → Scanner collects apps + system info
  → POSTs to /api/scan with session ID
  → Server looks up each app in SQLite
  → Returns categorized report
  → Browser redirects to report.html
Database: 8,880 apps total — 3,474 native ARM64, 5,401 emulated, 5 unsupported. SQLite, seeded from cache on startup if empty.
Database schema: Single apps table with fields: id, name, publisher, type (app/driver), arm_support (native/x64-emulated/x86-emulated/unsupported/unknown), architectures, source, source_url, notes, confidence, min_arm_version, last_updated
Scrapers:
server/scrapers/
├── index.js          ← orchestrator, runs all enabled scrapers (npm run scrape)
├── merge.js          ← shared merge helper, handles conflict resolution and confidence boosting
├── winget.js         ← searches Winget manifests for ARM64, search-based with caching
└── community/
    └── worksonwoa.js ← WorksOnWoA 8,772 app database (MIT licensed, Linaro/Microsoft)
└── vendor/
    └── qualcomm.js   ← placeholder
Merge logic: Higher confidence wins on conflicts. Corroborating sources boost confidence (up to 1.0). Winget confidence: 0.95. WorksOnWoA: 0.75-0.90 based on validation source (qualcomm/microsoft = 0.90, community = 0.75).
Scanner design:

Default mode: --quick (uses Prefetch for recently used apps, falls back to --standard if Prefetch unavailable)
--standard — all winget-exported apps, skips system noise
--full — everything
--local flag for dev testing against localhost:3000
Collects: Windows version, CPU, RAM, architecture, is_arm flag
localhost:7878 handshake passes session ID from browser to scanner
20 second timeout on browser connection, then creates standalone session

Scoring: Native = full positive, emulated = moderate penalty, unsupported = negative, unknown = neutral. Confidence indicator shows matched/total apps.
File structure:
ngpcx/
├── server/
│   ├── server.js          ← Express, /api/stats, /api/scan, /api/session
│   ├── db.js              ← SQLite setup, schema, seed on startup
│   ├── seed.js            ← seeds DB from cache if empty on startup
│   └── routes/scan.js     ← POST /api/scan, fuzzy name matching
│   └── scrapers/          ← see above
├── public/
│   ├── index.html         ← landing page, Run Scan button, live stats
│   ├── report.html        ← results page with gauge, confidence, system info, tables
│   └── ngpcx-scanner.exe  ← production Rust exe (no flags = hits ngpcx.com)
├── scanner/               ← Rust project
│   └── src/main.rs
├── data/
│   └── compatibility.db
├── .cache/
│   ├── winget/            ← cached GitHub API responses (committed to repo)
│   └── worksonwoa/        ← cached projects.json
└── PROJECT_BRIEF.md
What we are NOT doing: No TypeScript, no Next.js, no React, no Tailwind, no running scanner from web server, no running scrapers on Windows.
Infrastructure:

GitHub: https://github.com/erictriumph/ngpcx (auto-deploys to Railway on push)
Hosting: Railway (free tier)
Domain: ngpcx.com → Cloudflare → Railway
Local dev: Windows, VS Code, D:\projects\ngpcx, Node 24, Rust 1.96

Current status: Full production flow working on ngpcx.com. Scanner downloads, runs, submits, browser auto-redirects to report. 13/24 apps matched on test machine, score 100, "Moderate Confidence". Railway seeding from committed cache on every deploy.
Known issues / next priorities:

Done: [GitHub PAT expires in ~7 days] → PAT renewed July 4, 2026, expires ~Oct 2, 2026
No emulated apps showing (all test machine apps are native or unknown) — need more data
Cisco Webex, Splashtop, GoTo Opener likely have ARM64 but not in database yet
Debug logging still in scanner (Raw request line, Extracted session, Submitting to) — remove before public launch
Privacy/transparency page needed before public launch — what the scanner reads/sends
Code signing certificate for .exe (~$200-400/year) — reduces security warnings
Driver scraping not yet built
Community submission page not yet built
Railway Volume for persistent database ($0.25/GB) — needed when Railway free tier is upgraded
Scheduled scraper runs not yet configured
Scan depth UI toggle (quick/standard/full) not yet on landing page

Local dev testing flow:

Start server: node server/server.js
Open localhost:3000, click Run Scan, cancel/ignore exe download
Run: cargo run --manifest-path scanner/Cargo.toml -- --standard --local
Browser auto-redirects to report

Scraper commands:

npm run scrape — runs all enabled scrapers (Winget + WorksOnWoA)
npm run scrape:winget -- --letters=g,m — targeted Winget run
npm run scrape:woa — WorksOnWoA only

Please confirm what we're tackling before writing any code.