# NGPCX — ARM Readiness Scanner
Project brief — updated 2026-07-05

## Overview
NGPCX is an ARM Readiness Scanner for Windows users considering a Snapdragon laptop. Built to scratch the founder's own itch — no equivalent tool exists. Learning project with real utility. Potential affiliate monetization (laptop recommendations) is a bonus, not the goal.

## The 3 components
- **Server** — Node.js + Express, plain JavaScript (no TypeScript), SQLite database, runs on Railway (auto-deploys from GitHub on push)
- **Scrapers** — Run locally or on a schedule, never on Windows in production
- **Scanner** — Rust .exe, runs locally on user's Windows machine, sends JSON to server, displays report in browser

## Data flow
```
Browser clicks Run Scan
  → Creates session on server
  → Downloads ngpcx-scanner.exe
  → Polls localhost:7878 passing session ID + selected scan level
User runs scanner
  → Scanner listens on localhost:7878 (3s timeout if --local, 20s otherwise)
  → Browser connects, passes session ID + scan level
  → Scanner collects system info, apps, devices, printers
  → POSTs to /api/scan with session ID
  → Server looks up each app in SQLite; devices/printers pass through unscored
  → Returns categorized report
  → Browser redirects to report.html
```

**Scan level precedence:** CLI flag (`--quick`/`--standard`/`--full`, for dev convenience) → browser-selected level (real users, passed via the 7878 handshake) → hardcoded "quick" default if neither is present. No separate exe builds or CLI-only distribution needed — one exe, level chosen at scan time.

## Database
8,880 apps total — 3,474 native ARM64, 5,401 emulated, 5 unsupported. SQLite, seeded from cache on startup if empty.

**Schema:** Single `apps` table — id, name, publisher, type (app/driver), arm_support (native/x64-emulated/x86-emulated/unsupported/unknown), architectures, source, source_url, notes, confidence, min_arm_version, last_updated. `type` now used to prevent name-collision between app and driver entries in `merge.js`'s matching logic (drivers not currently populated via scraping — see Driver/device data section below).

## Scrapers
```
server/scrapers/
├── index.js          ← orchestrator, runs all enabled scrapers (npm run scrape)
├── merge.js          ← shared merge helper, type-aware matching, conflict resolution and confidence boosting
├── winget.js         ← searches Winget manifests for ARM64, search-based with caching
└── community/
    └── worksonwoa.js ← WorksOnWoA 8,772 app database (MIT licensed, Linaro/Microsoft)
└── vendor/
    └── qualcomm.js   ← placeholder
```

**Merge logic:** Higher confidence wins on conflicts. Corroborating sources boost confidence (up to 1.0). Winget confidence: 0.95. WorksOnWoA: 0.75-0.90 based on validation source (qualcomm/microsoft = 0.90, community = 0.75).

**Driver/device data — approach changed, see below.** A `server/scrapers/drivers/windowsupdatecatalog.js` scraper was built and tested, then abandoned: the Update Catalog's search requires POST + ASP.NET viewstate handling (a plain GET returns a static shell regardless of query — confirmed via byte-identical responses across ten different search terms), and more importantly, Microsoft's Terms of Use for this property prohibits reproducing/copying information obtained through it — a real conflict with storing scraped results in our own DB. Do not revisit bulk-scraping this source. See "Device detection" below for the approach that replaced it.

## Scanner design
- Default mode: quick level determined by handshake (see Data flow above), CLI flags still work for local dev
- `--local` flag shortens the 7878 handshake timeout to 3s (vs 20s in production) for faster dev iteration
- Collects: Windows version, CPU, RAM, architecture, is_arm flag, installed apps, connected/recent devices, installed printers
- Scoring: Native = full positive, emulated = moderate penalty, unsupported = negative, unknown = neutral. Confidence indicator shows matched/total apps.

### Device detection (new — 2026-07-05)
Real hardware ID: for the reasoning trail behind every decision below, this was extensively validated against real devices (webcam, USB mic, BT-dongle-as-USB-audio, HID input, fingerprint reader, FIDO security key, network printer) during development — not just designed in the abstract.

**USB peripherals** (`get_devices()` in `main.rs`):
- Classes scanned: `Printer`, `Image`, `MEDIA`, `Biometric`, `SmartCardReader`, `Camera`, `HIDClass`
- Filtered to entries with a `VID_xxxx&PID_xxxx` pattern in InstanceId (excludes virtual/software bus devices, which start with `SW\`)
- **Composite device dedup:** grouped by VID/PID (ignoring the `MI_xx` interface suffix), since one physical device often registers multiple interface rows. Representative display name prefers a non-generic interface name; "fido" is explicitly preserved as meaningful even though it matches the generic-name pattern otherwise (security keys must not display as "Keyboard Generic" or similar).
- **Classification uses the most conservative class across all interfaces** of a composite device — e.g., a security key exposing both a generic HID interface and a SmartCardReader interface stays classified as SmartCardReader (flagged for review), not silently promoted via its other interface.
- **Presence + recency tiering** (critical nuance — do not simplify without re-reading the reasoning): a device continuously connected for months never updates `DEVPKEY_Device_LastArrivalDate` (it only fires on (re)connect), and a device recently unplugged after heavy use isn't reflected by arrival date either. The correct signal combines three properties:
  - `IsPresent` (via `Get-PnpDevice -PresentOnly:$true` membership) — always qualifies, any tier
  - `DEVPKEY_Device_LastRemovalDate` if not present — closer proxy for "recently used" than arrival
  - `DEVPKEY_Device_LastArrivalDate` as fallback only if no removal date exists
  - **Tiers:** Quick = present OR ≤8 days; Standard = present OR ≤60 days OR unknown; Full = everything, no filter
  - Important gotcha already hit once: `Get-PnpDevice -PresentOnly:$false` does NOT mean "ignore presence" — it means "show only NON-present devices." Omit the parameter entirely for true unfiltered enumeration.

**Printers** (`get_printers()` in `main.rs`):
- Via `Get-Printer`, not `Get-PnpDevice` — network printers (IP/WSD ports) have no USB VID/PID at all and are invisible to the device-based approach
- Deduped by `DriverName` (not `Name` — the same physical printer often creates multiple queues, e.g. one via direct IP and one via WSD discovery, sharing a driver name)
- Filtered to exclude virtual printers (PDF, OneNote, Fax, XPS, and generically-named "Virtual" drivers)
- No reliable recency signal exists for printers (`Get-Printer` doesn't track last-print-job time without heavier event-log mining) — **printers are always included regardless of scan tier**, a deliberate simplification rather than an oversight
- Flagged `is_network: true/false` based on port name pattern (`IP_` / `WSD-`)

**Driver-check heuristic (report.html):**
- "Likely native" (no vendor driver needed, no check required): device class is `Camera`, `HIDClass`, or `MEDIA` — these correspond to standardized USB device classes (UVC, HID, USB Audio Class) with Windows-inbox drivers regardless of vendor. Validated against real devices via web search: Logitech Brio webcam, RØDE PodMic USB, Poly BT600 (Bluetooth headset via USB audio dongle — note the dongle presents as standard USB audio to Windows; Bluetooth transport itself is irrelevant to this classification), Logitech HID input device.
- Also "likely native": printer driver names matching common Windows-inbox printer driver patterns (IPP Class Driver, Mopria, Universal Print, PCL6/PostScript Class Driver) — untested against a real device as of this writing, worth validating when one is available.
- **Stays "worth a check"** (search link shown, no claim made): `Biometric`, `SmartCardReader`, and any vendor-specific (non-generic) printer driver. Validated: Kensington VeriMark fingerprint reader — real-world search result was genuinely ambiguous ("legacy models lack standalone ARM64 driver, current models handled via Windows Update"), confirming this category needs a human to check, not a heuristic.
- Search links point to a plain web search (`"<device name> ARM64 driver"`), not the Windows Update Catalog — catalog search frequently returns nothing even for hardware that does have ARM64 support, and even when results exist, architecture info is buried in a per-item detail popup, not visible in the results list. Not worth the friction or the ToS exposure.
- **Explicitly NOT evaluated:** Bluetooth/WiFi radio chipset ARM64 compatibility. This is a real, historically significant pain point for Windows-on-ARM (early Snapdragon laptops shipped with combo radio chips lacking day-one ARM64 driver support) but is architecturally different from the peripheral-level detection this scanner does. Worth a clear disclaimer; not in scope to solve via heuristic.

**Report page additions:**
- "Detected devices" table (name, category, last-seen, driver-check column) — separate section from app tables, own summary banner (not crammed into the 4-card app summary grid, which looked wrong with an odd 5th card)
- Summary banner: total count + "likely native" count + "worth a check" count, links down to the full table
- Disclaimer notes covered classes and that "likely native" is a heuristic, not a guarantee — vendor companion apps for extra features may still lack ARM64 support even when core device function doesn't need one

## File structure
```
ngpcx/
├── server/
│   ├── server.js          ← Express, /api/stats, /api/scan, /api/session
│   ├── db.js              ← SQLite setup, schema, seed on startup
│   ├── seed.js            ← seeds DB from cache if empty on startup
│   └── routes/scan.js     ← POST /api/scan, fuzzy name matching, passes devices through unscored
│   └── scrapers/          ← see above
├── public/
│   ├── index.html         ← landing page, scan-level radio group + Run Scan button, live stats
│   ├── report.html         ← results page with gauge, confidence, system info, tables, devices section
│   └── ngpcx-scanner.exe  ← production Rust exe (no flags = hits ngpcx.com)
├── scanner/               ← Rust project
│   └── src/main.rs
├── data/
│   └── compatibility.db
├── .cache/
│   ├── winget/            ← cached GitHub API responses (committed to repo)
│   └── worksonwoa/        ← cached projects.json
└── PROJECT_BRIEF.md
```

## What we are NOT doing
No TypeScript, no Next.js, no React, no Tailwind, no running scanner from web server, no running scrapers on Windows. No bulk-scraping the Windows Update Catalog (ToS conflict + technical fragility — see Scrapers section).

## Infrastructure
- GitHub: https://github.com/erictriumph/ngpcx (auto-deploys to Railway on push)
- Hosting: Railway (free tier)
- Domain: ngpcx.com → Cloudflare → Railway
- Local dev: Windows, VS Code, D:\projects\ngpcx, Node 24, Rust 1.96
- GitHub PAT renewed 2026-07-04, expires ~2026-10-02 — set a reminder before then

## Code signing & distribution decisions
- **Signing: Azure Trusted Signing** (now branded "Artifact Signing"), not a traditional OV certificate. ~$10/month vs. $200-400/year for equivalent trust outcome — same SmartScreen reputation-building result, dramatically cheaper. Available to individual developers in the US/Canada (orgs also covered in EU/UK).
- **Requires a personal Azure subscription/identity separate from ADS** — Eric to verify his existing Azure account isn't tied to ADS credentials/tenant before starting identity validation; if it is, create a fresh personal Microsoft account and Azure subscription rather than untangling the existing one. Cost to start clean is $0 (free-tier Azure subscription); only the ~$10/mo Trusted Signing cost applies once active. **Status: pending — Eric to verify tomorrow (ADS business hours).**
- Signing integrates via SignTool/Azure CLI/GitHub Actions — a build-time step, not a hosting change. No impact on Railway/GitHub Actions/domain setup.
- **Distribution: direct exe download remains the primary path and default CTA.** Microsoft Store listing (via MSIX packaging) is a secondary, opt-in option only — not the front door. Reasoning: target audience (consumers/prosumers personally researching a Snapdragon laptop purchase, discovered via web/forums) will most often land on ngpcx.com directly rather than searching the Store first; adding a Store-detour before "Run Scan" adds friction for the primary funnel. Corporate/locked-down environments (where Store access may be blocked) are a smaller slice of this specific audience, since corporate ARM purchase decisions are typically made by IT procurement, not individual users running a personal readiness scan.
- If/when MSIX packaging happens: the scanner should stay a thin console app that hands off to the default browser for reporting (no native UI needed) — MSIX doesn't require a GUI, and duplicating the report UI natively would be wasted work. Two unknowns to verify before investing packaging time: (1) whether Store certification requires some minimal visible UI presence even for console-style tools, (2) whether packaged Win32 MSIX apps retain unrestricted localhost network access (the 7878 handshake depends on this).
- Store registration itself is now fee-free for both individual and company developer accounts (Microsoft dropped both fees as of 2026), removing what would have been a separate cost consideration.

## Known issues / next priorities
- "Full" scan mode's **app-scanning** still behaves identically to Standard — only device detection got true tiering treatment. The `get_installed_apps()` mode branching only distinguishes `quick` from everything else.
- `GENERIC_DRIVER_NAME_PATTERNS` regex (generic/inbox printer driver name matching) not yet validated against a real device using e.g. Microsoft's IPP Class Driver — untested edge case, low risk but unverified.
- Debug logging still in scanner (raw request line, extracted session, submitting to) — deliberately deferred, still actively useful during ongoing development; revisit before public launch, not before.
- Privacy/transparency page still needed before public launch — should include: what the scanner reads/sends, confirmation that port 7878 never accepts external/inbound connections (local loopback only — all real network traffic is HTTPS/443 to ngpcx.com), and the device-detection disclaimer language (covered classes, "likely native" is a heuristic not a guarantee, Bluetooth/WiFi radio compatibility not evaluated).
- Code signing certificate — see Azure Trusted Signing section above, pending Eric's Azure identity verification.
- Driver scraping — approach changed from bulk-scrape to on-demand, non-stored search links (see Device detection section). Community submission page (self-reported compatibility, WorksOnWoA-style) intentionally deferred as a v2.0-scope feature with its own separate lifecycle — not being pursued now.
- Report page could use a "want a deeper scan? No need to re-download, just run the scanner again" nudge for users who already have the exe from a prior visit — not yet built.
- Railway Volume for persistent database ($0.25/GB) — needed when Railway free tier is upgraded.
- Scheduled scraper runs not yet configured.
- Multi-device testing now underway (first production deploy of device detection went live 2026-07-05) — watch for device-class miscategorization as real-world hardware variety surfaces edge cases beyond what one dev machine could validate.

## Local dev testing flow
```
Start server: node server/server.js
Open localhost:3000, select scan level, click Run Scan, cancel/ignore exe download
Run: cargo run --manifest-path scanner/Cargo.toml -- --standard --local
Browser auto-redirects to report
```
`--local` also shortens the 7878 handshake timeout to 3s, so no-browser test runs (CLI-flag-only, e.g. confirming standalone-session fallback) don't require waiting 20s each time.

## Scraper commands
```
npm run scrape             — runs all enabled scrapers (Winget + WorksOnWoA)
npm run scrape:winget -- --letters=g,m   — targeted Winget run
npm run scrape:woa         — WorksOnWoA only
```
(Windows Update Catalog scraper built, tested, and deliberately not wired into the orchestrator or given a package.json script — abandoned per Scrapers section above.)