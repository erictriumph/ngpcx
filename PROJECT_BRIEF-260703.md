# NGPCX — ARM Readiness Scanner
## Project Brief

### What it is
A web tool that scans a Windows user's installed applications and reports how ready 
they are to switch to an ARM-based (Snapdragon) laptop. Users download a small 
Windows executable, run it, and get a personalized readiness score with a full 
breakdown of their apps.

### The 3 Components

**1. Server** (`/server`)
- Node.js + Express, plain JavaScript (no TypeScript)
- SQLite database via better-sqlite3
- Runs on Railway (auto-deploys from GitHub on push)
- Seeds database from cache on startup if empty

**2. Scrapers** (`/server/scrapers`)
- Run locally or on a schedule, never on Windows
- `index.js` — orchestrator, runs all enabled scrapers
- `winget.js` — primary scraper, searches Winget package manifests for ARM64 support
- `vendor/` — placeholder for vendor-specific scrapers (Adobe, Qualcomm, Microsoft)
- `community/` — placeholder for community scrapers (Reddit, GitHub)

**3. Scanner** (`/scanner`)
- Rust `.exe`, runs locally on user's Windows machine
- Exports installed apps via `winget export`, sends JSON to server
- Collects system info (OS, CPU, RAM, architecture)
- Communicates with browser via localhost:7878 handshake
- Scan modes: `--quick` (recent apps), `--standard` (default), `--full` (everything)
- Use `--local` flag for development against localhost:3000

### Data Flow
Browser clicks Run Scan
→ Creates session on server
→ Downloads ngpcx-scanner.exe
→ Polls localhost:7878 passing session ID
User runs scanner
→ Scanner listens on localhost:7878
→ Browser connects, passes session ID
→ Scanner collects apps + system info
→ POSTs to /api/scan with session ID
→ Server looks up each app in SQLite
→ Returns categorized report
→ Browser redirects to report.html

### Database Schema
Single `apps` table:
- `id` — Winget package ID (e.g. `7zip.7zip`)
- `name` — Human readable name
- `publisher` — Publisher name
- `type` — `app` or `driver`
- `arm_support` — `native`, `x64-emulated`, `x86-emulated`, `unsupported`, `unknown`
- `architectures` — e.g. `arm64`
- `source` — which scraper found it
- `source_url` — URL of the source data
- `confidence` — 0.0 to 1.0
- `min_arm_version` — earliest version with ARM64 support
- `last_updated`

### What We Are NOT Doing
- No TypeScript, no Next.js, no React, no Tailwind
- No running the scanner from the web server
- No running scrapers on Windows
- No running scrapers on Railway (for now)

### Infrastructure
- **GitHub:** https://github.com/erictriumph/ngpcx
- **Hosting:** Railway (free tier, auto-deploy from GitHub)
- **Domain:** ngpcx.com → Cloudflare → Railway
- **Local dev:** Windows, VS Code, `D:\projects\ngpcx`
- **Stack:** Node 24, npm 11, Git 2.54, Rust 1.96

### Scoring
- Native ARM64 = full positive weight
- x64-emulated = moderate penalty
- x86-emulated = higher penalty  
- Unsupported = negative weight
- Unknown = neutral (doesn't affect score)
- Score qualified by confidence indicator (known/total apps)

### Scanner Design Principles
- Always skip `C:\Windows\` — OS components always compatible
- Default scan uses `winget export` for clean JSON app list
- Skips system noise (VC++ redistributables, .NET runtimes, etc.)
- Collects: Windows version, CPU, RAM, architecture, is_arm flag
- Prefetch reading requires admin — falls back gracefully
- localhost:7878 handshake passes session ID from browser to scanner

### Monetization (future)
- Affiliate links for Snapdragon laptop recommendations
- Personalized based on spec data collected during scan
- Helpful, not pushy

### Future Work
- Driver scanning and compatibility data
- Additional scrapers (Qualcomm, vendor sites, Reddit/community)
- Community page — manual lookup and submission
- Railway Volume for persistent database ($0.25/GB/month)
- Code signing certificate for .exe (~$200-400/year)
- Scheduled scraper runs
- Confidence scoring improvements
- Unknown apps affecting score (weighted)
- Scan depth options in UI (quick/standard/full toggle)