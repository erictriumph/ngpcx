# WORKSPACE.md — Guided Assessment Workspace

## Status

**Design stage. No implementation yet.** This document is the authoritative design reference for the Workspace redesign, the same role CLAUDE.md plays for the scanner. It captures philosophy, responsibility boundaries, converged principles, and canonical terminology — deliberately not data models, scoring formulas, or UI layout. Those come later, once the questions this document flags as open have been resolved in their own sessions.

The Readiness Scanner is frozen (see CLAUDE.md, "Scanner considered feature-complete pending code signing"). This document assumes the scanner as a fixed, trusted observation engine and designs entirely on top of it.

---

## Philosophy

CheckMyARM does the heavy lifting first. The scanner and catalog build the richest, most honest picture of a system that evidence alone can support — with zero effort from the user. Then the product helps the user combine that picture with context only they can provide, to produce a recommendation tailored to them specifically.

**The scanner contributes evidence. The user contributes context. The recommendation emerges from both.** Neither substitutes for the other. Evidence without context is generic — it can tell you what's true about the software in general, not what matters to this person. Context without evidence is a guess — it can tell you what someone cares about, not whether it will actually work.

The product's job is not to get the user to "finish reviewing everything." It's to close the smallest set of genuinely open questions that would actually improve the recommendation, and to make that feel like progress rather than an obligation. A user should never feel like they're managing an inventory of 120 applications. They should feel like they're completing a short, meaningful assessment — one that mostly turns out to already be done.

**The assessment is the artifact — not any single page.** Results and Workspace are two views onto the same underlying assessment: one communicates its current, published state; the other is where that state's inputs get worked on. What a user exports, imports, and eventually acts on is the assessment itself — its accumulated evidence and Personal Context — not a snapshot of either page. This is why the two experiences can look and behave so differently without contradicting each other: they aren't competing products, they're two facets of one thing.

---

## Responsibility boundaries

**Results communicates the current assessment. The Workspace changes the inputs to that assessment. Recalculate is the intentional boundary between those two responsibilities** (see The Recalculate Boundary, below). Confusing these jobs — letting the Workspace re-decide compatibility, letting Results demand input before it will answer anything, or letting Results drift into a live dashboard — is the failure mode this section exists to prevent.

### Scanner
Discovers observable facts about the machine: installed software, connected/recent devices, driver evidence, and Guidance Signals (running, startup, launchable, AppX, unlisted). Reports facts, never judges relevance or importance. Frozen; out of scope for this redesign except as a fixed input.

### Results (the Report)
The first, unconditional destination after a scan completes, and the **only** place the Recommendation is ever shown. Answers the visitor's actual question — *should I consider a Windows on ARM PC* — using only what evidence can honestly support, with **zero required interaction**. Intentionally simple, largely non-interactive, printable and exportable: a Recommendation, a Score, a Confidence level, Primary Reasons, summary statistics, a short explanation of what Confidence means, and a single invitation to continue. Not a funnel whose real purpose is pushing people into the Workspace — a complete, standalone product on its own terms. **Never becomes a live dashboard.** Every value on it is frozen — from the original scan, or from the most recent Recalculate — never updated silently while the user is elsewhere.

### Workspace
An environment, not a second question-answering page. Exists to refine the assessment, not to produce the first Recommendation. Where **Personal Context** gets captured: validating or replacing the scanner's reasonable observational assumptions, prioritizing what actually matters, researching what's genuinely still open. Not an inventory-review UI — a **Guided Assessment**: a small, prioritized queue of open questions (**Uncertainties**), already front-loaded by Guidance Signals before the user does anything. Shows exactly one live number while the user works — **Confidence**, the assessment's live progress indicator — and nothing else from the Recommendation family: no Score, no label, no Primary Reasons update, until the user explicitly **Recalculates**. Persistent, resumable (export/import), never mandatory. Its existence should never make Results feel incomplete or provisional; a user can trust Results and leave without ever opening it.

### Recommendation
Not a page, and not something the Workspace ever renders directly. A construct — a readiness label, a score, an explanation, and Primary Reasons — that lives exclusively on Results, in exactly two forms: an **Initial** version (evidence only, shown the moment a scan completes) and an **Updated** version (evidence plus Personal Context, shown only after a Recalculate). **There is exactly one recommendation model**, computed at exactly one point in the flow. The Workspace never runs a parallel computation and never shows a live-updating Recommendation or Score.

---

## The Recalculate Boundary

Not a UI convenience — the formal seam between the Workspace's mutable working state and the assessment's published output.

Everything in the Workspace before a Recalculate is a draft: Personal Context accumulating, Confidence moving, nothing committed. Recalculate is the single moment that draft state is folded into a new, authoritative Recommendation. This boundary exists so "what the assessment currently says" (Results) and "what's being worked on" (Workspace) can never be confused with each other — there is no in-between state where a half-updated Recommendation is visible, and no path by which Workspace activity changes what Results shows except through this one, explicit, user-triggered action.

The boundary is cheap and repeatable, not destructive or final. Nothing about crossing it forecloses anything — a user can Recalculate, return to the Workspace, and Recalculate again as many times as the loop requires before exporting.

---

## Terminology

Canonical vocabulary for this redesign. Use these terms consistently going forward; older code/copy predates this split (see "Known terminology debt" below).

| Term | Meaning |
|---|---|
| **Evidence** / **Compatibility Evidence** | Objective facts the scanner or catalog can support — `arm_support` verdicts, confidence, source, driver evidence. Not personalized. |
| **Personal Context** | Everything only the user can supply — importance/priority, "I use this daily," "I no longer use this," self-verified status, manually added entries. |
| **Results** (a.k.a. "the report") | The immediate, always-available destination after a scan, and the only place the Recommendation ever appears. Today's `report.html`. |
| **Recommendation** | The label + score + explanation + Primary Reasons construct. Exists in exactly two forms — **Initial** (Results, evidence only) and **Updated** (Results, evidence plus Personal Context, produced only by a Recalculate). Both forms live on Results; the Workspace never renders either. |
| **Primary Reasons** | A small, fixed set of the biggest factors behind the current Recommendation, shown on Results directly beneath the Recommendation and Confidence. Each one is a doorway into the Workspace — reviewing the evidence behind it, or adding Personal Context that bears on it. |
| **Recalculate** | The explicit, user-triggered action that turns Personal Context accumulated in the Workspace into an Updated Recommendation. The *only* way the Recommendation ever changes. Always returns the user to Results. |
| **Workspace** | The persistent environment where Personal Context accumulates. Refines the assessment; never produces the first Recommendation and never renders one directly. |
| **Guided Assessment** | The interaction paradigm the Workspace uses — a small, prioritized queue of open questions rather than a full inventory. Results carries the orientation/summary job (see The Assessment Loop), so the Workspace opens directly into this queue. |
| **Uncertainty** | The atomic unit of work in the Workspace. See below. |
| **Entity** | An app or device, scanner-discovered or manually added — what an Uncertainty is *about*, not itself a unit of work. |
| **Completion** | Internal tracking of how many Uncertainties have both axes resolved — what empties the Needs Attention queue. Not displayed as its own headline number; see Design Principle 3. |
| **Confidence** | How well-supported the surviving, important resolutions are. The one number shown live while a user works in the Workspace. |
| **Readiness Score** | The existing numeric formula (`classifyApps()`). An *input* to the Recommendation, not the Recommendation itself, and never shown outside Results. |

### Known terminology debt

The current codebase already uses "Workspace" for `report.html` (page heading "Your ARM Readiness Workspace," export/import copy, etc.) from an earlier phase that predates this redesign. Under the vocabulary above, that surface is actually **Results**. This document does not resolve that rename — it's a sequencing decision for implementation, not a design one — but it should not be allowed to linger silently. Anyone picking up implementation work should treat "Workspace" in existing UI copy as provisional and expect it to be reconciled with this glossary.

---

## Design principles

1. **Automation proposes; the user decides.** Every default the system sets — importance, resolution state, priority — is visible and reversible in both directions: escalate something the system downplayed, or de-emphasize something it flagged as important. Overriding a default is refinement, not correction — see Guidance Signals' role, below.

2. **Heavy lifting happens first, silently.** The system's own evidence confidence and Guidance Signals default-resolve as much as can be responsibly defaulted *before* the user is ever asked anything. Both Results and the Workspace should open already mostly accounted for, not empty. This is a mechanical requirement, not a copywriting one — "most of the work is already done" has to be literally true of the underlying state, not just how it's framed.

3. **Confidence tracks progress toward a well-supported conclusion — not how much has been addressed.** Every Uncertainty's resolution state is tracked internally (this is Completion, and it's what empties the Needs Attention queue), but it is deliberately not surfaced as its own competing headline number. The one live number a user sees while working in the Workspace is Confidence, and it moves with evidence quality, not with queue size. A fully emptied queue can still be low-confidence if what's left is genuinely thin; a nearly untouched one can already be confident if what matters most is already strongly supported.

4. **Compatibility Evidence and Personal Context are distinct and jointly necessary.** Neither alone produces a tailored recommendation. They are tracked, presented, and reasoned about as separate inputs that combine — never flattened into one undifferentiated signal.

5. **Priorities lead; investigation follows.** The Workspace does not march through everything the scanner found in discovery order. It starts from what matters to this user — stated directly, or defaulted from Guidance Signals — and lets that ordering determine what gets investigated, and in what sequence. Investigation follows priority; it doesn't precede or define it.

6. **Reduce cognitive load; don't expose inventory.** The Workspace is not a longer, friendlier version of a 120-row table. Its unit of engagement is deliberately smaller and coarser than "every discovered thing" — see Uncertainty, below.

7. **Progress, not homework.** Every interaction should read as forward motion — something addressed — not a chore, a form field, or an obligation. This shapes how defaults, framing, and queue feedback should eventually be designed, even though this document doesn't design them.

8. **Results is a genuine destination, not a gate.** Nothing about the Workspace existing should make Results feel incomplete, provisional, or like a teaser for "the real product." A user who trusts the Initial Recommendation and never opens the Workspace has used this product correctly, not incompletely.

9. **Complexity is earned, not defaulted.** Results stays simple because reaching it required nothing from the user — arriving there is automatic, so what's shown has to be immediately trustworthy without asking anything back. The Workspace can be richer — more controls, more nuance, more surface area for research and personalization — precisely because reaching it was a deliberate choice to continue. Richness offered before it's asked for is friction; richness offered after a deliberate step forward is depth.

10. **One recommendation model, produced at one point, in one place.** The Workspace never becomes a second compatibility engine running in parallel to Results, and it never shows a live preview of what a Recalculate would produce. It supplies better inputs to the same computation, which runs only on Recalculate and is shown only on Results.

11. **Language should never claim more certainty than the evidence has.** Avoid words like "resolved" in anything user-facing, where it can imply a fact is known to be true rather than merely accounted for. "125 already provide enough information to support this assessment" is honest; "125 resolved" overclaims. This applies to Results copy and Workspace copy alike; internal/architectural vocabulary (e.g. "Uncertainty resolution" in this document) is precise on its own terms and isn't required to follow the same softening.

---

## The atomic unit of work: Uncertainty

An **Uncertainty** is not an app or a device. It is a bi-axial, resolvable question, anchored to one or more entities:

- **Research Status axis** — do we (CheckMyARM) know the compatibility fact? Resolved by evidence (catalog, community) or by the user explicitly acknowledging the gap and moving on — never required to resolve as "known," only as "settled for now."
- **Importance axis** — does this matter to *this* user? Resolved explicitly (the user states it) or by default (Guidance Signals and evidence confidence propose a value the user is free to override).

An Uncertainty is resolved when **both axes carry a value** — explicit or defaulted. This single definition is what makes several other principles fall out as consequences rather than special cases:

- Marking something "doesn't matter" resolves the Importance axis; an unresolved Research Status axis on a deprioritized item no longer blocks Completion. Optional items stop consuming investigation effort *because of this*, not because of a separate carve-out rule.
- Completion never requires a favorable outcome, because resolving the Research Status axis only requires the question to be settled, not answered positively.
- Confidence and Completion diverge naturally: Confidence is a function of evidence quality on the Uncertainties the user said matter; Completion just counts resolved axes. Only Confidence is ever shown live — see Design Principle 3.

Structural properties:
- **Many-to-many with entities.** One Uncertainty can span several entities (a dock's fragmented device rows resolving as one "will my dock work" question). One entity can carry more than one open Uncertainty (a research gap and an unset importance are independent).
- **Exactly one level of atomicity.** Uncertainties are not nested. Below them: entities and raw evidence, which Uncertainties are *about*. Above them: sections, which are display/triage aggregations of Uncertainties, not Uncertainties themselves.
- **Generated from evidence state, not fixed at scan time.** New or conflicting evidence (a community consensus that contradicts a user's self-verification, for example) can spawn a new Uncertainty even on something previously resolved. A deliberate "doesn't matter" resolution, by contrast, should not reopen just because new research evidence arrives — the user already said they don't care.

---

## Guidance Signals' role

Guidance Signals (running, startup, launchable, AppX, unlisted) were collected specifically to support Workspace organization, not recommendation scoring — see CLAUDE.md, Observation Enrichment milestone. In this design, that boundary is structural, not just a stated intent:

- They feed **default values on the Importance axis** (something running and set to start with Windows defaults to high importance; something found only via a stale registry entry with no recency signal defaults low).
- They feed **prioritization/triage ordering** — which open Uncertainties get suggested first, and in what order the Workspace's queue opens.
- They **never** touch the Research Status axis or the compatibility verdict. A Guidance Signal can make something feel more urgent to look at; it cannot make something more or less ARM-compatible.

These defaults are reasonable observational assumptions, not judgments. When a user overrides one, the scanner wasn't wrong — the Workspace did its job: Personal Context refined an assumption the scanner never had enough information to make with certainty in the first place. **This is refinement, not correction**, and the distinction matters for tone as much as architecture — nothing in this product should ever imply the scanner made a mistake.

---

## What the Workspace is not

- Not a data-entry form, and not graded on fields filled in.
- Not a second, parallel compatibility engine, and not a live preview of the Recommendation — see The Recalculate Boundary.
- Not a mandatory gate between Results and a usable conclusion — Results already gives one.
- Not a place where new discoveries get silently submitted to the shared catalog. Manually added entries and scanner-discovered "unlisted" apps stay local to the user's own Workspace unless they take the existing, separate, explicit "Share your Findings" action.
- Not a leaderboard, profile, or reputation system (unchanged from the rest of this project's existing stance).
- Not a redesigned data view of what Results already shows — a different job, not a denser version of the same one.

---

## The Assessment Loop

```
Scanner → Results → [Refine Assessment] → Workspace → [Recalculate] → Updated Results
```

A loop, not a line. A user may cross between Results and Workspace as many times as they want before ever exporting. Navigation stays fixed regardless of confidence level; only tone and emphasis adapt to it.

**Results** — purpose: answer the core question completely and honestly, with zero required interaction. Belongs: Recommendation, Score, Confidence, Primary Reasons, summary statistics, a short explanation of what Confidence means, and a single clear invitation ("Refine Assessment") into the Workspace. Does not belong: any decision or editing UI, exhaustive per-item review tables, anything that updates without a Recalculate.

The handful of items still genuinely open are *named* on Results, not hidden behind a click — communicated through a concise summary in the spirit of: *"We evaluated 129 applications and devices. 125 already provide enough information to support this assessment. Only 4 could benefit from additional context."* Because Results can name what's still open but can't let a user act on it there, this preview has to do real work on its own — a visible reason per item, not just a count — without ever becoming interactive. Acting on any of them means Refine Assessment, the single navigational step into the Workspace, where those same items become the Needs Attention queue.

Confidence-adaptive messaging is entirely a tone question, never a routing one: high confidence and little left that evidence alone could improve → a soft, optional-feeling invitation ("refine further if you'd like"). Low confidence, or important-looking items still open → a more clearly valuable invitation ("a few minutes could meaningfully sharpen this"). Same page, same route either way.

**Workspace** — purpose: refine, not produce, the assessment. Belongs: the Needs Attention queue (already ordered by Guidance-Signal-derived default Importance before the user does anything), the actual resolution interactions, a live Confidence indicator, section drill-down, research aids (the existing "Check →" links and similar). Does not belong: the Recommendation, Score, or Primary Reasons in any live form, or new discovery, which stays the scanner/Rescan's job.

**Recalculate** — always returns the user to Results, now in its Updated form: same page, same grammar as the Initial version, sharper values, carrying enough context to show *why* it moved (which resolved items mattered) so the change reads as earned rather than arbitrary. See The Recalculate Boundary for why this is architectural, not incidental.

---

## Workspace v1 (proposed scope)

The smallest coherent slice of the architecture above that is still honestly the philosophy, not a preview of it. Two tests governed every inclusion/deferral decision: **(a)** does leaving this out make v1 feel like the old inventory-review model wearing new copy, and **(b)** does including it require solving one of the Unresolved Questions first. Anything that fails test (a) had to be in. Anything that only survives by failing test (b) had to be out.

**What v1 is:**

- **Results and Workspace as genuinely separate destinations.** The two-destination shape, connected by Refine Assessment and Recalculate, is core architecture, not an enhancement layered onto a single page — the two experiences being distinct from each other is precisely what makes both of them work. v1 doesn't need every mechanic elaborated (Primary Reasons can start as a short, simply-ranked list; Recalculate can be a plain full recompute rather than an incremental one), but the separation itself is not optional.
- **Uncertainty, bi-axial, at 1:1 granularity.** Every app and device entity gets Research Status and Importance tracked as two distinct values, not one flattened decision. This is a reframing of what already exists, not new interaction surface: the current five-value personal-decision model (`personally_verified`, `no_longer_use`, `waiting_for_vendor`, `doesnt_matter`, default) already encodes both axes, just merged into one field. `personally_verified` and `waiting_for_vendor` are Research Status resolutions (the second is exactly the "settled without being answered" case this document describes); `doesnt_matter`/`no_longer_use` are Importance resolutions. v1 splits the existing enum into two tracked axes instead of inventing a new one. **No entity clustering** — the many-to-many relationship between Uncertainties and entities (the dock case) is real architecture but not v1; every Uncertainty maps to exactly one entity for now.
- **Guidance Signals set defaults, not just descriptions.** `is_running`/`is_startup`/`has_start_menu_entry` already exist in the payload and are already unused past their own fields. v1's actual job is to consume them: seed a default Importance per entity (running + startup-registered defaults high; no recency signal and never running defaults low) and use that same score to order the Needs Attention queue. This is the cheapest available capability and the one most responsible for whether v1 *feels* like the philosophy above — it's the mechanism behind "most of the work is already done" being literally true rather than asserted.
- **Completion tracked, not displayed.** Computed as the fraction of entities where both axes carry a value, explicit or defaulted — but shown nowhere as its own number. It's what shrinks the Needs Attention queue; Confidence is the only live figure a v1 user actually sees.
- **Priority-first grouping within the Workspace, not type-first.** The existing Native/Emulated/Unsupported/Unknown tables get reorganized into **Needs Attention** (both axes still open, ranked by default Importance), **Already Resolved** (native/high-confidence or user-verified, collapsed by default), and **Set Aside** (Importance resolved as "doesn't matter"/"no longer use," collapsed, still exported). Applied separately within Apps and within Devices — those stay the two real containers; no richer taxonomy. System Components keeps its existing separate, excluded-from-scoring treatment unchanged. Labels here are placeholders, not final copy.
- **Everything already built keeps working.** Export/import, Rescan carry-forward, Share your Findings, the System Components disclaimer — none of this is rebuilt, only reframed where the data underneath it changes shape (e.g. export payload gains the split axes instead of one flattened decision field, and a Recalculate timestamp instead of implicit live state).

**What's intentionally deferred, and why:**

1. **Uncertainty clustering / a typed taxonomy** (dock-as-product, shared "is emulation acceptable" spanning many apps, etc.). This is Unresolved Question 1 — most of the actual design work still ahead. Attempting it now risks either shipping it half-built or consuming the entire v1 budget.
2. **"Background Components" / "Browser Applications" as distinct sections.** These need the runtime/support-utility categorization CLAUDE.md already documents as deferred, for lack of a reliable signal (Start Menu presence was the candidate, and that's deferred too, per the Device review). v1 shouldn't invent a Workspace-side classification the scanner side already said it can't yet support responsibly.
3. **Manual entries** (apps/devices the user adds that the scanner never found). Serves a different problem — discovery completeness — than v1's core loop, which is resolving uncertainty about what was already found. Introduces a new local-only data surface orthogonal to the resolution loop.
4. **Surfacing `unlisted_apps` / `appx_apps` as investigable content.** Neither feeds the score today, by explicit design (see CLAUDE.md, Observation Enrichment). Pulling ~90+ AppX entries into the assessment surface would directly undermine the "small handful" promise v1 exists to prove. The per-entity *boolean* Guidance Signals on already-scored apps are used; the new discovery *arrays* are not yet surfaced as content.
5. **A richer Importance model.** v1 keeps Importance close to today's shape (a small ordinal, reusing the existing weighting), deferring a richer version.
6. **The Confidence formula redesign.** v1 reuses/relabels the existing weighted-synthesis math rather than building the "quality-weighted, restricted to what the user marked important" version this document describes conceptually (Unresolved Question 3 stays open).

**The user's journey through v1, Results through completion:**

The scan finishes and Results loads already partially accounted for — Guidance-Signal defaults have already filled in Importance for most entities, and high-confidence catalog matches have already filled in Research Status for most of the rest. The page reads as a complete verdict on its own: label, score, Confidence, and Primary Reasons. Nothing on it requires interaction to trust.

The "already did the work" moment needs three things visible together on Results, with no scrolling and no interaction: the total scope ("129 things evaluated"), the remainder shown *concretely* — the actual short list of names, not a second number — and one visible reason per surviving item, drawn directly from Guidance Signals ("currently running," "starts with Windows"). A bare percentage is a claim a skeptical user can dismiss; a list with no visible reasoning looks arbitrary rather than intelligent, which reads as incomplete, not impressive. Language here matters: "already provide enough information to support this assessment," not "already resolved."

Choosing Refine Assessment moves the user into the Workspace, which opens directly into the Needs Attention queue — no separate orientation screen, because Results already did that job. Resolving an item — confirming its Importance, confirming or overriding its Research Status — removes it from the queue immediately, and Confidence updates live. Marking something "doesn't matter" empties it from the queue too, without moving Confidence at all — the first place a user can *feel* the distinction between working-through-things and evidence-quality, rather than being told about it. Score, label, and Primary Reasons do not move during this — they wait for Recalculate.

There is no forced end state inside the Workspace. A user can leave after resolving nothing, having trusted the Initial Recommendation outright — that's Results doing its job. A user can address a couple of Needs Attention items, Recalculate once, and stop. Or a user can empty the queue entirely before ever recalculating, at which point Recalculate produces the Updated Results — deliberately without implying a favorable outcome, since a fully worked-through assessment can still land on "Not Recommended Yet." What's being communicated at that point is that the assessment was thorough, not that it was good news; the Recommendation itself is whatever the evidence and the user's own priorities actually support.

---

## Unresolved questions

Deliberately not solved here. Listed so they aren't rediscovered from scratch in a future session.

1. **Uncertainty-type taxonomy.** The fixed vocabulary of question shapes (dock-as-product, emulation-tolerance, driver-availability, still-in-use, feature-specific gap, etc.) that determines how entities cluster into shared Uncertainties. This is most of the actual design work still ahead.
2. **Default-resolution thresholds.** How confident evidence and Guidance Signals need to be before an axis is allowed to auto-resolve versus surface as an open item — and whether that threshold is global or varies by category (apps vs. devices vs. system components).
3. **Confidence formula's precise shape.** Conceptually "quality-weighted, restricted to what the user said matters" — the actual weighting isn't designed.
4. **Relationship to community contribution.** Today, "Share your Findings" (community submission) and this design's Personal Context / Uncertainty resolution are separate mechanisms. Does resolving an Uncertainty ever prompt or fold into a community submission, or do the two stay fully decoupled?
5. **Terminology migration timing.** When the existing `report.html` "Workspace" branding gets reconciled with the Results/Workspace split defined here. `report.html` likely needs to become two things, not one relabeled thing — not a design question, but a sequencing one that shouldn't be allowed to drift indefinitely.
6. **Personal Context's persistence boundary.** Is a Workspace scoped to one assessment (one scan, possibly rescanned), or can Personal Context ("I don't use RightSight") persist as something closer to a portable profile across rescans or even different machines? Export/import implies some persistence model already; its exact boundary isn't settled.
7. **Devices' relationship to the score.** Devices currently contribute nothing to the Readiness Score (see CLAUDE.md, Device/driver detection). Does resolving a device-related Uncertainty change that, and if so, how does a still largely app-shaped score formula accommodate it?
8. **Unlisted/AppX/PWA discoveries' relationship to Optional and to the catalog.** Should Workspace-only discoveries (portable apps, AppX packages) ever be promotable into the shared catalog by explicit user action, the way manually-typed entries currently are not? Or are scanner-discovered "unlisted" items treated differently from purely manual entries?
9. **How much Workspace state needs to survive a Recalculate.** The Recalculate *boundary* is settled — see above. Its mechanics aren't: does it require a full page transition (Workspace state persisted server-side or in the export format before navigating away) or can it be an in-place recompute? A data-lifetime question, not a UI one, and it affects how much "session" the Workspace needs versus how much it can lean on the existing export/import mechanism.
10. **How Primary Reasons get selected.** A simple top-N by some ranking (most impactful on the score, most Guidance-Signal-relevant, or both) is the obvious starting point, but the actual selection logic isn't designed, and different choices could make the Recommendation feel differently justified for the same underlying evidence.
