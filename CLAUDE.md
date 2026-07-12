# NGPCX — ARM Readiness Scanner

## What this is
Free Windows ARM (Snapdragon) readiness scanner. Consumer-facing brand: CheckMyARM — live on the visitor-facing pages (see Branding & monetization section); redirect domain still pending. Learning project with real utility; affiliate monetization is a bonus, not the goal.

## Branding & monetization
- CheckMyARM is the consumer-facing name; NGPCX is the underlying project/codebase name — both are intentional, not a half-finished rename. CheckMyARM appears in visitor-facing text only: page `<title>`s, nav logos, and footers across `index.html`, `report.html`, `admin-research.html`, `admin-revisit.html`. Everything else stays NGPCX: the `ngpcx-scanner.exe` filename, the GitHub repo, all variable/function names, code comments, the `ngpcx_admin_secret` localStorage key, and the scanner's hardcoded server URL (`get_server_url()` → `ngpcx.com` — must stay stable regardless of branding, since already-distributed exes can't be updated).
- Logo is live: a 64px PNG (`public/logo-64.png`) paired with the text wordmark (`CheckMy` + `<span>ARM</span>` on the main pages, `CheckMyARM` + `<span>Admin</span>` on admin pages) in every nav, plus a full favicon set (`favicon.ico`, 16/32/48px PNGs, `apple-touch-icon.png`, `android-chrome-*` sizes) wired via `<head>` tags on all four HTML pages. Source files (multiple sizes, the original SVG wrapper, and generation notes) live in `branding/` at the repo root — not served, kept for reference/future regeneration. `logo-source.svg` is not a true vector, it's an 817×817 raster PNG wrapped in SVG, so that's the resolution ceiling if a larger version is ever needed.
- Ko-fi is live at `https://ko-fi.com/checkmyarm` — used in `report.html`'s donation callout and both visitor-facing footers (`index.html`, `report.html`). Affiliate links are still **placeholder/nonexistent** — the "affiliate links" mention in `report.html`'s donation callout is plain text, not a link, until an actual affiliate program exists. Don't wire up real affiliate tracking without checking first.

## Stack — do not deviate without asking
- Server: Node.js + Express, **plain JavaScript, no TypeScript**. SQLite (better-sqlite3). Runs on Railway, auto-deploys from GitHub on push.
- Scanner: Rust .exe (`scanner/src/main.rs`), runs locally on the user's Windows machine only.
- No React, no Next.js, no Tailwind. No running the scanner from the web server. No running scrapers on Windows in production.

## Architecture essentials
- Scan level (quick/standard/full) travels through the localhost:7878 handshake between browser and scanner — never CLI-flag-only, never separate exe builds. CLI flags exist for dev convenience and always win over the browser-provided level (see `get_cli_scan_mode()` precedence in `main.rs`).
- `--local` flag shortens the 7878 timeout to 3s (vs 20s prod) for faster dev iteration.
- Session IDs use `crypto.randomUUID()` (Node). Sessions expire after 24h — this is enforced server-side in both `/api/session/:id` and the scan-submission handler in `scan.js`, not just written and ignored.
- All HTML rendering of app/device names goes through an `escapeHtml()` helper in `report.html` — never insert external data into `innerHTML` unescaped. This project has a real stored-XSS history (device FriendlyName is attacker-influenceable via USB descriptors); do not reintroduce raw interpolation.

## Data sources for apps (in `server/scrapers/`)
- `winget.js` — GitHub-search-based, ARM64 installer detection, confidence 0.95
- `community/worksonwoa.js` — WorksOnWoA DB, confidence 0.75–0.90
- ARP (`get_arp_apps()` in `main.rs`) — Windows Uninstall registry, supplements winget for apps it misses (Office, Adobe, vendor tools). No confidence scoring; feeds `merge_arp_into_apps()` which dedupes against winget-found apps by normalized name, always runs (all scan tiers), not gated by mode.
- **Never build a scraper against Windows Update Catalog or Microsoft Store's undocumented catalog API** — both investigated and rejected: Catalog requires POST+viewstate (a plain GET returns a static shell) and conflicts with Microsoft's ToU on reproducing catalog content; Store's catalog API is undocumented with unclear ToS. If asked to revisit either, flag the prior investigation before proceeding.
- GitHub release-asset checking (arm64/aarch64 in release asset filenames) is the approved pattern for OSS app compatibility — same technique already used in `winget.js`'s installer YAML check, safe under GitHub's ToS.

## Device/driver detection (`main.rs`)
- Classes scanned: Printer, Image, MEDIA, Biometric, SmartCardReader, Camera, HIDClass. Filtered to `VID_xxxx&PID_xxxx` pattern InstanceIds (excludes `SW\` virtual bus devices).
- Composite devices (one physical device, multiple USB interfaces) are deduped by VID/PID. Display name prefers non-generic interface names; "fido" is explicitly preserved even though it matches the generic-name filter (security keys must not display as "Keyboard Generic"). Classification uses the **most conservative class across all interfaces** — a device with any Biometric/SmartCardReader interface stays flagged for review even if it also exposes a generic HID interface.
- Recency signal is `IsPresent` OR `LastRemovalDate` OR `LastArrivalDate` (in that fallback order) — never arrival date alone. A continuously-connected device never updates arrival date; a recently-unplugged device is better signaled by removal date than by a stale arrival date. Tiers: Quick = present only (no per-device property lookups — this is what makes Quick fast); Standard = present OR ≤60 days OR unknown; Full = everything.
- **Gotcha, don't reintroduce:** `Get-PnpDevice -PresentOnly:$false` means "show ONLY non-present devices," not "ignore presence." Omit the parameter entirely for true unfiltered enumeration.
- Printers via `Get-Printer` (not `Get-PnpDevice` — network printers have no USB VID/PID at all). Deduped by `DriverName`. Always included regardless of scan tier (no reliable recency signal exists for them).
- "Likely native" driver-check heuristic: device class is Camera, HIDClass, or MEDIA (standard USB device classes with Windows-inbox drivers — UVC, HID, USB Audio Class) — validated against real hardware (webcam, USB mic, BT-dongle-as-USB-audio, HID input). Stays "worth a check" (search link, no claim) for Biometric/SmartCardReader and vendor-specific printer drivers — validated as genuinely ambiguous via real search results (Kensington fingerprint reader case).
- Driver/app "Check" links point to a plain web search (`"<name> ARM64 driver"` or similar) — **not** Windows Update Catalog (see rejection above).

## System component classification
- Currently done client-side in `main.rs` via `is_system_component()` (Microsoft-publisher gate + name pattern match). **Known architectural gap, in progress:** this should move server-side into `scan.js` so it's updatable without a new exe release, and so `apps` table entries with `type: 'system'` (added via the admin research tool, see below) can override the pattern-guess going forward. `AppEntry` currently lacks a `publisher` field needed for this — must be added and threaded through `merge_arp_into_apps()` before the server-side move.
- System components get their own report bucket (separate from Unknown), muted styling, excluded from score calculation, with a disclaimer noting they're not evaluated and don't affect the score.

## Admin research tool (`server/routes/admin.js`, `public/admin-research.html` — WIP)
- Auth: shared secret via `ADMIN_SECRET` env var, checked via `x-admin-secret` header or `?secret=` query param. **Not real security** — deliberately low-stakes, meant to be manually removed from the public deploy when not in active use. Do not upgrade this without being asked; the low-effort approach was a deliberate choice, not an oversight.
- `unknown_apps` table (name, count, last_seen) tracks every app a real scan found with zero DB match — populated by `trackUnknownApp()` in `scan.js`. This is the admin tool's work queue, sorted by count (frequency = priority).
- Resolving an app writes to `apps` via `mergeApp()` with `source: 'admin'`, `confidence: 1.0` (should always win future merge conflicts), then deletes the row from `unknown_apps`.
- Philosophy: **no automated research, no paid search API.** Admin manually researches (using the same "Check →" search links end users see) and submits verdicts. This was a deliberate simplification after investigating and rejecting live GitHub-lookup and search-API-plus-LLM approaches as too much ongoing cost/complexity for this stage. Don't propose automating this without being asked — it was a considered decision, not a placeholder.

## Distribution / signing decisions (not yet executed, don't re-litigate without asking)
- Signing: Azure Trusted Signing (~$10/mo), not a traditional OV cert ($200-400/yr) — same trust outcome, cheaper. Requires a personal Azure identity separate from ADS (Eric's employer) — pending verification.
- Distribution: direct .exe download stays the primary path/CTA. Microsoft Store (MSIX) is secondary/optional, not the front door — target audience finds the site via web/forums before searching the Store.
- Scanner's server URL is hardcoded (`get_server_url()` in `main.rs`) — currently `https://ngpcx.com`. Any future domain/branding change must keep this endpoint stable regardless of what the public-facing site is called, since already-distributed exes can't be updated.

## Known open items (check before assuming something isn't started)
- "Full" scan mode's app-scanning is identical to Standard — only devices got true tiering treatment.
- Prefetch app-matching had a `.exe`-suffix bug (fixed) — Quick-mode app detection may still be unreliable on SSD systems where Windows disables Prefetch tracking entirely; this was observed but not solved.
- Per-app expandable detail rows (source/confidence/notes) are built in `report.html`, using data `scan.js` already returns but previously went unused.
- Community submission feature is deliberately deferred (v2.0+) — the admin research tool is designed as a stepping stone toward it (same "resolve while checking" UX pattern), not a replacement.

## Style
- Dictation-first author, conversational but precise prose elsewhere in the project (docs, LinkedIn posts) — not relevant to code style, but worth knowing if asked to write user-facing copy.
- Security-practitioner audience for some users (Rochester Security Summit, Black Hat Europe submissions reference this project) — code and copy should hold up to scrutiny from technically sophisticated readers, not just casual users.
