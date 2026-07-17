# Workload-Aware Assessment — Investigation (Research Only)
Investigation date: 2026-07-18. No code changed, no UI built, no recommendation-engine logic modified. This document is a technical assessment, not a design or implementation plan — treat it the way `WORKSPACE.md` was treated before its own implementation began: a reference for a future decision, not a commitment.

## Methodology and dataset
Two sources were used, and are kept clearly separate throughout this document:
1. **Architecture/data inventory** — read directly from the scanner source (`scanner/src/main.rs`), the server (`server/routes/scan.js`, `server/scrapers/*`), the catalog schema (`server/db.js`), and the existing deterministic classification logic (`public/assessment.js`). This is general — true regardless of whose machine is scanned.
2. **Illustrative real dataset** — a genuine scan session already sitting in the local dev database from earlier work today (150 classified apps, 10 devices, `AMD Ryzen 5 5600G with Radeon Graphics`, 31GB RAM, Standard assessment). This is **your real machine**, not synthetic test data — I did not fabricate examples. Every concrete app name cited below (AMD Chipset Software, ASRock A-Tuning, etc.) is a real, currently-installed application on that machine, used exactly as you proposed: as a representative corpus, not as the model for the solution.

Findings are labeled **[General]** (architectural, true regardless of machine) or **[This machine]** (specific to your desktop, included for illustration) throughout.

---

## 0. Executive summary

**Yes — a meaningful first version of workload-aware relevance can be built almost entirely with deterministic logic and data the system already has or could cheaply add, with AI reserved for a narrow, well-bounded edge case.**

Three findings drive that conclusion:
- **[General]** A structured, 57-category taxonomy already exists in data the system already downloads — it's just being discarded during ingestion (WorksOnWoA's `categories` field, currently flattened into an unindexed notes string). This alone likely covers the majority of the "what kind of software is this" question at effectively zero marginal cost.
- **[General]** The desktop-hardware-utility problem (chipset tools, RGB software, GPU control panels) is architecturally a *different* problem from compatibility classification, not a harder version of the same one — the compatibility catalog has near-zero coverage of this software category (confirmed against real data below), so it can't be the data source. The scanner's own observation (name + publisher, matched against a small, generic, non-vendor-specific pattern set) is the right layer, and this codebase already has three working, tested examples of exactly that shape (`isMicrosoftAppxPackage`, `isSystemComponent`, `isBrowserHostedPWA`).
- **[General]** One missing field — machine chassis type (desktop/laptop/convertible), a single cheap WMI read — would do more for this specific capability than almost anything else investigated, because "is a discrete GPU control panel relevant" is fundamentally a form-factor question, not a compatibility question.

The gaps that remain (a genuinely ambiguous "is this app gaming-relevant" call, or an app the deterministic layer has never seen before) are better handled by **user confirmation** than by AI — see Section 6.

---

## 1. Existing metadata inventory

### 1a. What the scanner already emits, per app (`AppEntry` in `scanner/src/main.rs`)
| Field | Type | Notes |
|---|---|---|
| `name`, `id`, `version`, `publisher` | strings | `id` is a stable key for winget/appx apps; ARP apps often lack one |
| `discovery_source` | `winget`\|`arp`\|`running-process`\|`appx` | Already load-bearing for `isMicrosoftAppxPackage`/`isBrowserHostedPWA` (Section 3) |
| `recently_used`, `is_running`, `is_startup`, `has_start_menu_entry`, `is_pinned_taskbar` | booleans | Guidance Signals — footprint/importance evidence, not workload signals, but relevant as override evidence (Section 5) |
| `launch_count`, `days_since_last_launch` | numbers | UserAssist-derived, same role as above |
| `focus_count`, `focus_time_ms` | numbers (experimental) | Unused in scoring today |
| `default_handler_count`, `default_handler_categories` | number, `["browser","mail"]` | The one place a *category*-shaped field already exists, but scoped to exactly two values by design |

### 1b. What the scanner already emits, per device (`DeviceEntry`)
`name`, `class` (Printer/Image/MEDIA/Biometric/SmartCardReader/Camera/HIDClass/Net/Display), `hardware_id`, `days_ago`, `is_network`, `manufacturer`, `driver_service`, `driver_provider`.

**[General] Real gap for this investigation, not a scanner bug:** the device classes are all USB/HID/printer-class — the scanner has no visibility into *internal* PCIe hardware (discrete GPU, motherboard chipset controller) as a "device" at all. **[This machine]** confirmed directly: this machine's real device list is entirely USB peripherals (a Poly headset, RODE mic, Logitech input device, a fingerprint reader, a network printer) — zero GPU/chipset device records, even though the *software* for exactly that hardware is present (see 1e). This means the desktop-hardware-relevance signal has to live at the **installed-software** layer, not the device layer — the device scanner simply can't see the hardware this category of software is companion to.

### 1c. What the catalog (`apps` table) stores today
`id, name, publisher, type, arm_support, architectures (unused/NULL), source, notes (free text), confidence, last_updated`. **No structured category column exists.** The only place category-like information could hide is inside the free-text `notes` field.

### 1d. What the data sources actually provide (the most consequential finding in this section)
**[General] WorksOnWoA (`.cache/worksonwoa/projects.json`, 8,772 entries) carries a structured `categories` array per app already.** I measured it directly against the real cache file rather than assuming:

```
total entries:              8,772
entries with categories:    8,769   (99.97%)
distinct category values:   57
```

Top categories by frequency: `prod` (1,423), `unknown` (1,374), `dev-tools` (905), `photo` (781), `oss` (689), `entertainment` (580), `utils-tools` (555), `it-tools-vdi` (297, i.e. **virtualization** — directly maps to a category on your list), `music` (287), `education` (274), `creative` (226), `business` (197), `security` (147), `vpn` (62), `endpoint-sec` (45), `anti-virus` (26), `cad` (38), `printers` (24), `browsers` (22), `benchmarking` (16).

**This data is fetched today and then discarded.** `server/scrapers/community/worksonwoa.js`'s `buildAppEntry()` does exactly this:
```js
notes: app.categories ? `Categories: ${app.categories.join(', ')}` : null,
```
The structured array becomes a display-only string inside a free-text notes field, un-queryable, un-indexed, silently lost. **Capturing it as a real structured field (e.g. a new `apps.categories` JSON column, or a join table) requires zero new network cost — the data is already on disk in `.cache/worksonwoa/projects.json` and already flows through `mergeApp()` on every scrape run.** This is the single highest-value, lowest-cost recommendation in this entire investigation.

Two caveats, stated plainly: (a) `unknown` is itself the second-most-common category (~16% of entries) — real coverage for a "confidently categorize this app" purpose is closer to 84%, not 99.97%; (b) `printers` appears only 24 times and desktop-hardware-vendor categories don't meaningfully exist at all in this taxonomy (see 1e) — WorksOnWoA is an "apps that run" community database, not a hardware-utility database, so this source alone does not solve Section 3.

**[General] Winget, by contrast, currently captures nothing category-shaped, and the reason is architectural, not an oversight.** `server/scrapers/winget.js` is GitHub-*search*-based — it never downloads a package's actual manifest YAML, only the search-result metadata (package ID, publisher, a manifest URL). Winget manifests do have an optional `Tags:` field in principle, but capturing it would mean fetching and parsing the real manifest body for every package — a new network cost per app, not a free re-read of already-cached data the way WorksOnWoA's fix is. I did not find a way to verify real-world Tags coverage/quality without doing that fetch, so I'm flagging this as a *plausible but unverified* secondary source, meaningfully more expensive than the WorksOnWoA fix, not a peer to it.

### 1e. Source-machine-specific software has almost no representation in the catalog — a load-bearing finding for Section 3
I searched the live 8,890-app catalog for common desktop-hardware-vendor terms:

```
rgb           4 hits (all irrelevant — color-picker/hex-conversion tools, not lighting control)
aura          4 hits (1 genuine: ASUS "TUF Aura Core"; 3 irrelevant)
dock          5 hits (all irrelevant — Docker, taskbar-dock utilities, not USB dock drivers)
bios          1 hit  (irrelevant)
chipset, motherboard, firmware, armoury, mystic light, icue,
g hub, overclock, fan control, realtek audio, synaptics,
nvidia, geforce, radeon, thunderbolt                          0 hits, every single one
```
Publisher-string search across the whole catalog: ASUSTeK (2), MSI (2), Dell (1), Lenovo (7), and **zero** for Corsair, Razer, Logitech, Gigabyte, EVGA, NVIDIA, AMD, Intel, Realtek, Synaptics, HP.

**Interpretation:** this isn't a scraper bug — it's an honest reflection of what the sources are. WorksOnWoA/winget-pkgs are populated by people testing whether *consumer/prosumer applications* run on ARM; nobody bothers ARM-testing an AMD chipset driver utility, because the question is meaningless (there's no AMD chipset on a Snapdragon laptop to control). **This means workload-relevance detection for desktop-hardware software cannot be built on catalog data at all — by construction, the catalog barely contains this category.** It has to be detected directly from what the scanner observed (name/publisher), independent of whether that name ever resolves to a compatibility verdict.

**[This machine]**, this exact category is richly represented in the real installed-software list, which is exactly why it prompted the investigation:
```
AMD Chipset Software           | Advanced Micro Devices, Inc. | ARP  | unknown
AMD Software                   | Advanced Micro Devices, Inc. | ARP  | unknown
AMD Install Manager            | Advanced Micro Devices, Inc. | ARP  | unknown
RAIDXpert2 Management Suite    | Advanced Micro Devices, Inc. | ARP  | unknown
A-Tuning v3.0.503              | ASRock Inc.                  | ARP  | unknown   (motherboard tuning utility)
ASRRGBLED v2.0.182             | ASRock Inc.                  | ARP  | unknown   (literally RGB LED control)
Realtek Ethernet Controller Driver | Realtek                  | ARP  | unknown
Realtek Audio Driver           | Realtek Semiconductor Corp.  | ARP  | unknown
Realtek Audio Console          | (GUID publisher)             | appx | unknown
I-Menu                         | AOC                          | ARP  | unknown   (monitor OSD utility)
```
All ten are currently sitting in the "Unknown" bucket, all ten are genuinely irrelevant to a travel-laptop purchase decision, and none of them would ever resolve to a real compatibility verdict from either data source — they're the kind of noise the Background/Reference milestone (documented in `CLAUDE.md`) was built to filter, but that milestone's structural rule (Microsoft-first-party AppX + browser-hosted PWA) doesn't reach third-party desktop-hardware software at all. This is a real, current gap, not a hypothetical.

### Recommendation for new fields (ranked by value/cost)
| Field | Source | Cost | Value | Why |
|---|---|---|---|---|
| **Structured `categories` from WorksOnWoA** | Already-fetched cache, currently discarded | Near zero — a scraper/schema change, no new network calls | High | Covers ~84% of the catalog with a real, broadly-applicable, already-existing taxonomy |
| **Machine chassis type (Desktop/Laptop/Convertible/Tablet)** | One WMI property (`Win32_SystemEnclosure.ChassisTypes` or `Win32_ComputerSystem.PCSystemType`), scanner-side | Very low — one more field on `SystemInfo`, no new PowerShell call class | High, specifically for Section 3 | The real question "is chipset/GPU/RGB software plausible here" is a form-factor question first; this is the one field that answers it directly and generalizes across every vendor by construction |
| Winget `Tags` field | Requires fetching+parsing real manifests, not just search results | Meaningfully higher — new per-package network cost | Unverified, likely moderate | Flagged as a real possibility, not a confirmed one; would need its own small research pass before committing |

Both of the two low-cost fields are **broadly applicable** — neither is vendor- or product-specific, matching the investigation's stated preference.

---

## 2. Deterministic classification feasibility (broad functional groupings)

Estimated using the real WorksOnWoA category data above, cross-referenced against the real machine's app list where a concrete anchor was useful. These are informed estimates from real data, not measured ground truth — no labeled validation set exists to score against, which is itself listed as a gap in Section 6.

| Grouping | Expected coverage | Confidence | Likely false positives | Likely false negatives |
|---|---|---|---|---|
| **Development** | High (`dev-tools` = 905 entries, 10% of catalog) | High | Low — dev-tools is a fairly clean category | IDE plugins/CLI-only tools that never got listed with a category |
| **Productivity/Business** | High (`prod` + `business` ≈ 1,600 entries) | Moderate — "productivity" is a broad, sometimes catch-all label | Moderate — general-purpose tools (a PDF reader) tagged `prod` regardless of actual use pattern | Low |
| **Creative/Media** | High (`creative`+`photo`+`music`+`multimedia` ≈ 1,400) | Moderate-High | Low | Apps that are creative-adjacent but categorized `utils-tools` instead |
| **Security** | Moderate (`security`+`endpoint-sec`+`anti-virus`+`vpn` ≈ 280) | High for the ones tagged | Low | High — security tools are often ARP-only, never catalog-matched at all, so category never applies (**[This machine]**: Check Point SmartConsole, a real VPN/firewall client, sits in Unknown with no category, confirming this) |
| **Virtualization** | Low-moderate (`it-tools-vdi` = 297) | Moderate | Low | Likely significant — VDI-adjacent tools without an explicit category tag |
| **Browser / PWA** | High, but via a *different* mechanism entirely | High | None | None — this is already solved deterministically (see below) |
| **Gaming** | Moderate (`entertainment` = 580, imprecise — includes non-gaming entertainment apps) | Low-Moderate | Moderate — media players and streaming apps land in the same bucket as actual games | Moderate — many games are Store/AppX-only and never touch WorksOnWoA at all (**[This machine]**: Angry Birds Friends, Last War, Red's Club — all AppX games — carry zero category data since they're not in the WorksOnWoA corpus) |
| **Desktop hardware utility / Driver-Firmware / Peripheral software** | **Not derivable from catalog data at all** (Section 1e) | N/A via catalog; **high** via a dedicated scanner-observation heuristic (Section 3) | — | — |
| **Communication** | Moderate — no single clean WorksOnWoA category maps to this; scattered across `prod`/`business`/`web-social`/`collaboration` | Low via category alone | — | Significant — this would likely need its own small capability signal (e.g. app name/publisher pattern for known chat/meeting clients), not a pure category lookup |

**Browser-hosted PWA deserves a specific callout**: this exact "many apps legitimately belong to more than one category" problem is already solved, deterministically, in this codebase — `isBrowserHostedPWA()` doesn't try to categorize *what kind* of PWA something is; it identifies the structural TYPE (ARP-sourced, browser-vendor publisher string) and lets the `'supported'` bucket carry that fact forward. **[This machine]** ten real Chrome-hosted PWAs (Google Calendar, TripIt, Google Maps, ChatGPT, Google Gemini ×3, Wyze Web Live) are already correctly identified this way, with zero WorksOnWoA/Winget category data involved at all. This is a working precedent for "detect the structural TYPE, not the content" reasoning, which Section 4 argues is the right general approach.

---

## 3. Source-machine-specific detection (chipset/motherboard/firmware/GPU utilities)

**Yes, this looks reliably detectable — but via a different mechanism than compatibility-catalog lookup, and via structural signals rather than a vendor-name list.**

Two independent, combinable signals, both already validated as a *pattern* elsewhere in this codebase:

**Signal A — generic keyword match against `discovery_source: 'arp'` app names**, gated the same way `isSystemComponent()` already gates on a Microsoft-publisher prefix: a small set of *function words*, not vendor names — "chipset," "rgb led," "tuning," "management suite," "raid," "audio console," "ethernet controller driver," "on-screen display." **[This machine]**: this single small pattern set would correctly catch AMD Chipset Software, ASRRGBLED, A-Tuning, RAIDXpert2, Realtek Ethernet/Audio Driver, and I-Menu — 6 of the 10 real examples — without a single vendor name in the pattern list.

**Signal B — form-factor gate (chassis type, Section 1's top recommendation)**: whether this signal *matters at all* is conditioned on the machine actually being a desktop. On a real laptop, "AMD Chipset Software" is not noise — it's the one piece of software actually keeping the machine's onboard chipset current, and should not be suppressed. **[This machine]** confirms the gate is meaningful: this specific desktop genuinely has 10 real examples; a laptop scan would very plausibly have zero, and the *absence* of chassis-type context would then be the only thing preventing this heuristic from silently mislabeling legitimate laptop chipset software as "desktop-irrelevant" on some other machine.

**What this should become**: exactly the framing in your prompt — "an assessment-level relevance suggestion," not a compatibility decision. The compatibility verdict for AMD Chipset Software (native/emulated/unsupported/unknown) is unaffected; only whether the assessment treats it as something worth the user's attention changes. This is architecturally identical to the existing `isBackgroundApp()` mechanism (Section 5) — a second, independent reason an item might recede into a background/reference role, orthogonal to the Microsoft-AppX/browser-PWA reasons already there.

**Confidence and limits, stated honestly:** Signal A will have real false negatives — hardware utilities with no distinguishing generic keyword in their name (e.g. a bare product name like "iCUE" or "G HUB" with no descriptive suffix) won't match a keyword list by design, since the whole point is avoiding a vendor/product name list. Signal B is a strong disambiguator but a coarse one — a "desktop replacement" laptop workload (explicitly one of your five example workloads) deliberately wants exactly the opposite behavior from a "travel" workload on the *same* chassis-type signal, which is precisely why this has to stay a workload-*context* input to the assessment layer, never a scanner-side filter (see Section 5's "keep the boundary" argument).

---

## 4. Scalability across vendors and ecosystems

**The two mechanisms above generalize well; the risk is entirely in *how* they'd be implemented, not whether the underlying idea can generalize.**

- **AMD / Intel / Qualcomm / NVIDIA / OEM utilities**: Signal A (generic function-word matching) is vendor-agnostic by construction — it never encodes "AMD" or "ASRock," only "chipset software," "tuning," "RGB." This is the right shape and the real, present-day AMD/ASRock examples validate it works on at least one real vendor family. It has not been tested against Intel/NVIDIA/Qualcomm-branded equivalents (Intel Driver & Support Assistant, NVIDIA GeForce Experience, Qualcomm's own OEM tools) — those weren't present on this machine, so this is a genuine, stated limit of the validation, not a claim of universal coverage.
- **Open-source software / LibreOffice-class alternatives**: WorksOnWoA's `oss` category (689 entries) exists as a real, separate tag from `prod`/`dev-tools` — meaning "this is the open-source alternative to X" is not something the taxonomy currently encodes at all (LibreOffice would land in `prod`, same category as Microsoft Office, with nothing distinguishing "same function, different vendor"). A many-to-many capability model (Section 5) is the correct answer here — LibreOffice and Microsoft Office should both carry a `productivity` capability tag; nothing about that requires knowing they're alternatives to each other.
- **Microsoft applications**: already the best-covered case in this codebase — `isMicrosoftAppxPackage()` (publisher-contains-"microsoft" OR AppX package-family-name starts with "Microsoft.") is validated against real data with a documented, fixed failure mode (a name-fuzzy-match to an unrelated catalog entry can overwrite the scanner's own publisher hint — worked around by trusting `app.id`, not the merged publisher, for exactly this check). This is the strongest existing evidence that structural/publisher-based reasoning outperforms name-pattern lists.
- **Google/PWA equivalents**: already solved (Section 2, browser-hosted PWA detection) — generalizes to Edge/Firefox/Brave by the same mechanism, no Google-specific logic involved.
- **Avoiding vendor/product exception lists**: every mechanism recommended in this document (generic keyword sets, publisher-string structural checks, discovery-source gates, category taxonomy lookups) is capability- or function-based, not a maintained list of "known hardware brands" or "known games." The one place a maintained list would creep in — a curated set of communication/chat-client names, since no clean category signal exists for that grouping (Section 2) — is flagged honestly as the weakest link in the "avoid exception lists" goal, not hidden.

---

## 5. Architectural impact — smallest additions that preserve flexibility

The existing separation (scanner observes → catalog classifies compatibility → assessment layer interprets relevance) is already the right shape for this capability, and nothing about workload-awareness requires touching the first two layers. Concretely:

- **Many-to-many functional capabilities, not a single-category field.** A `capability_tags` concept (whether stored as a JSON array column on `apps`, a join table, or computed client-side from the WorksOnWoA category array once captured per Section 1) should let one app carry multiple tags — LibreOffice is legitimately both `productivity` and `oss`; RODE RODECentral is legitimately both `peripheral-utility` and `content-creation`. This directly matches your instruction to favor many-to-many over rigid single-category classification, and matches the existing precedent: `isBackgroundApp()` already composes from *two independent* structural checks (`isMicrosoftAppxPackage() || isBrowserHostedPWA()`) rather than a single enum — the many-to-many shape is already how this codebase's closest analogous problem was solved.
- **Assessment-specific relevance state, not a catalog field.** Compatibility (`arm_support`) is a fact about the software. Workload relevance is a fact about *this assessment* — the same app is desktop-irrelevant on a travel-laptop assessment and highly relevant on a desktop-replacement assessment of the identical machine. This is architecturally identical to how `critical_to_me`/Personal Context already work: assessment-scoped, never written back to the shared catalog. A workload selection would most naturally live as a new, small piece of assessment-scoped context (not unlike scan level today), read by a relevance function, never by `classifyApps()`.
- **Confidence/explanation metadata is a cheap, high-value addition, and there's already a template for it.** The existing `evidenceDetailHtml()`/Importance Evidence stack pattern (interpreted phrases, never raw scores, gated behind Deeper Research Mode) is the right existing mechanism to extend — a workload-relevance suggestion should read "Category: Desktop Hardware Utility (chipset software, detected by name pattern) — likely low relevance for a Travel workload," not a bare confidence number. This preserves the project's standing "interpreted phrases only, never raw numbers surfaced" discipline.
- **User overrides already exist and generalize for free.** `critical_to_me` already overrides `isBackgroundApp()`'s verdict unconditionally (`hasBackgroundOverride()`). A workload-relevance verdict should almost certainly compose through the exact same override, not a second, parallel override mechanism — one more reason weight is being multiplied down, not a new concept.
- **The recommended smallest concrete change, if this were ever pursued:** a single new `isWorkloadIrrelevant(app, workloadContext)`-shaped function, following the identical structure `isBackgroundApp()` already uses (structural candidate check, then an override check for deliberate-use evidence or explicit user confirmation), feeding into `computeSynthesis()` as one more multiplicative weight alongside `BACKGROUND_WEIGHT`/`DOESNT_MATTER_WEIGHT` — not a new scoring model, not a new classification pipeline, not a schema change to `apps` beyond the categories column already recommended in Section 1.

**What should explicitly stay separated:** the scanner should never gain workload awareness — it observes the same evidence regardless of intended use, exactly as `main.rs`'s current design already insists on ("the scanner observes and reports; the assessment layer decides emphasis"). The catalog should never gain a workload column — compatibility is a fact about software, not about a person's trip. Both boundaries are already correctly drawn in the current architecture; workload-awareness is a pure addition to the assessment layer, not a rearrangement of the existing three layers.

---

## 6. Gap analysis

| Gap | Best answer | Why |
|---|---|---|
| ~16% of WorksOnWoA entries are tagged `unknown` (no usable category) | **Additional metadata** (a possible Winget-Tags fetch, once its coverage is actually verified) or accept as a known residual gap | Not a reasoning problem — the source data simply doesn't have an answer for these |
| Desktop-hardware software with no distinguishing generic keyword (bare brand-name utilities like "iCUE") | **A small curated taxonomy**, scoped and bounded the same way `SYSTEM_COMPONENT_PATTERNS` already is (10 generic terms, not hundreds of brand names) | A handful of genuinely ambiguous cases don't justify inventing a new detection paradigm; a small, reviewed, generic-word list is proportionate and matches existing precedent |
| No clean category signal for "communication/chat client" software | **A small curated taxonomy**, or **user confirmation** if the list would otherwise creep toward being product-specific | This is the one grouping investigated where deterministic category data genuinely doesn't exist yet; a short, principle-based list (video-conferencing, instant-messaging function words) is more defensible than guessing per-vendor |
| Whether a specific app is "gaming-relevant" for a Gaming workload when it's ambiguous (e.g. Discord — communication tool, but heavily gaming-adjacent) | **User confirmation** | This is a genuinely subjective, context-dependent call that differs person to person even for the identical app — exactly the kind of case the existing Personal Context / "This matters to me" override already exists to handle, not a case to force a deterministic verdict onto |
| An app the deterministic layer has never encountered at all (no WorksOnWoA/winget match, no recognizable keyword, no clear publisher signal) | **User confirmation first; AI only if that's insufficient at scale** | This is the only place in the whole investigation where deterministic logic has genuinely nothing to go on — not a reasoning limitation, an information limitation. Per your instruction to reserve AI for genuine inadequacy: an LLM could plausibly infer a workload category from a bare app name in exactly this case, but that's a meaningfully different, much larger scope decision (introducing AI dependency into the recommendation pipeline for the first time) that this investigation deliberately does not recommend triggering yet — the observed gap here is narrow (residual "no data at all" cases after deterministic classification + community/user confirmation), not broad enough on the evidence gathered to justify it now |

**Overall verdict on the six-part question you asked:** deterministic logic, built from data the system already has (once the WorksOnWoA categories fix lands) plus one cheap new scanner field (chassis type), appears capable of handling the large majority of workload-relevance classification with the same structural-reasoning approach already proven out in this codebase's Background/Reference milestone. The genuine residual gap is narrow, concentrated in a handful of ambiguous or data-absent cases, and better addressed by a small curated taxonomy plus user confirmation than by AI. Nothing found during this investigation suggests the current scanner/catalog/assessment separation needs to change to preserve this future direction — it already does.
