// ─────────────────────────────────────────────────────────────────────────
// assessment.js — shared between report.html (Results) and workspace.html
// (Workspace). See WORKSPACE.md for the architecture this implements.
//
// Results reads this file to compute a read-only view of the current
// assessment. Workspace reads AND writes through it as the user provides
// Personal Context. Neither page owns this logic exclusively — that's the
// point: one recommendation model, computed the same way regardless of
// which page is asking.
//
// No server-side persistence here, ever. Personal Context lives in
// sessionStorage only, two distinct mechanisms:
//   - the GENERIC carry-forward stash (fixed key, one-shot, existing
//     mechanism) — crosses a session-ID boundary (Rescan, Import).
//   - the SESSION-SCOPED stash (keyed by session id, read/write
//     continuously) — how Results and Workspace communicate within one
//     session's Refine Assessment / Recalculate loop.
// ─────────────────────────────────────────────────────────────────────────

const DECISION_VALUES = ['personally_verified', 'no_longer_use', 'waiting_for_vendor', 'doesnt_matter', 'research_note'];
const VERIFIED_STATUS_VALUES = ['native', 'x64-emulated', 'x86-emulated', 'unsupported'];
// Single shared source for friendly status labels — previously duplicated
// (and, on Results, missing entirely, leaking raw enum values like
// "x64-emulated" into the "You verified" badge). One copy so the two pages
// can't silently disagree on wording.
const SUBMISSION_LABELS = {
    native: 'Native ARM64',
    'x64-emulated': 'x64 Emulated',
    'x86-emulated': 'x86 Emulated',
    unsupported: 'Unsupported',
};
// Bumped by hand alongside releases — no build step exists to auto-inject this.
const CMA_VERSION = '1.0.0';
const CARRY_FORWARD_KEY = 'ngpcx_carry_forward_v1';
const DOESNT_MATTER_WEIGHT = 0.25;
const CRITICAL_WEIGHT_MULTIPLIER = 2;
// Same order of magnitude as DOESNT_MATTER_WEIGHT (a distinct concept, not
// reused directly, so each can be retuned independently later): a
// background-typed app (see isBackgroundApp()) isn't excluded outright —
// still counted, still honest — just not weighted as a real assessment
// driver by default.
const BACKGROUND_WEIGHT = 0.25;

function sessionContextKey(sessionId) {
    return 'ngpcx_session_context_' + sessionId;
}

// Same normalization used project-wide (scan.js classifyApps, merge.js
// findExistingId) — reused verbatim rather than reinvented.
function normalizeAppName(name) {
    return (name || '').toLowerCase().replace(/[\s\-_.]/g, '');
}

// id first (stable across renames), normalized name otherwise — matches the
// same precedence classifyApps() itself uses when matching against the catalog.
function decisionKey(app) {
    return (app.id && String(app.id).trim()) || normalizeAppName(app.name);
}

// Devices have no catalog id — hardware_id (VID/PID) is the closest stable
// identifier; name is the fallback for devices that lack one (rare).
function deviceDecisionKey(device) {
    return (device.hardware_id && String(device.hardware_id).trim()) || normalizeAppName(device.name);
}

// A stable per-item anchor, independent of which priority bucket the item
// currently sits in (bucket membership changes as decisions change, so a
// position-based id would break as a deep link the moment something moves).
// Prefixed by kind so an app and a device that happen to normalize to the
// same key can never collide on one id.
function itemAnchorId(key, isDevice) {
    const safe = String(key).toLowerCase().replace(/[^a-z0-9]/g, '');
    return 'item-' + (isDevice ? 'device-' : 'app-') + safe;
}

// Validates one imported/carried-forward entry against the known enums before
// it can ever reach the synthesis math or the DOM. Unrecognized decision/status
// values fall back to a safe no-op rather than propagating a bad value into the
// whole page's headline numbers.
function sanitizeImportedEntry(raw) {
    if (!raw || typeof raw !== 'object' || typeof raw.app_name !== 'string' || !raw.app_name.trim()) return null;
    const decision = DECISION_VALUES.includes(raw.decision) ? raw.decision : 'research_note';
    const hasValidStatus = decision === 'personally_verified' && VERIFIED_STATUS_VALUES.includes(raw.verified_status);
    const safeDecision = (decision === 'personally_verified' && !hasValidStatus) ? 'research_note' : decision;
    return {
        app_name: raw.app_name.trim(),
        app_id: typeof raw.app_id === 'string' && raw.app_id.trim() ? raw.app_id.trim() : null,
        decision: safeDecision,
        verified_status: hasValidStatus ? raw.verified_status : undefined,
        critical_to_me: raw.critical_to_me === true,
        note: typeof raw.note === 'string' ? raw.note.slice(0, 2000) : '',
        researched_at: (typeof raw.researched_at === 'string' && !isNaN(Date.parse(raw.researched_at)))
            ? raw.researched_at : new Date().toISOString(),
        is_device: raw.is_device === true,
    };
}

// ─────────────────────────────────────────
//  Personal Context storage
// ─────────────────────────────────────────

// Reads the session-scoped stash (continuous, not one-shot) for the given
// session id. Returns a plain array of sanitized entries, never a Map — the
// caller decides how to key it.
function readSessionContext(sessionId) {
    if (!sessionId) return [];
    try {
        const raw = sessionStorage.getItem(sessionContextKey(sessionId));
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.map(sanitizeImportedEntry).filter(Boolean);
    } catch (err) {
        return [];
    }
}

function writeSessionContext(sessionId, entries) {
    if (!sessionId) return;
    try {
        sessionStorage.setItem(sessionContextKey(sessionId), JSON.stringify(entries));
    } catch (err) {
        // sessionStorage unavailable/full — Personal Context stays in-memory
        // only for the rest of this page view, which is a safe degradation.
    }
}

const IMPORTED_ASSESSMENT_SNAPSHOT_KEY = 'ngpcx_imported_assessment_snapshot_v1';

// A historical Assessment snapshot from an imported export file, consumed
// exactly once under the same explicit ?carryForward=1 gate as the
// personal-context stash below — shown on Results for comparison against
// the freshly (re)computed assessment. Legacy-format imports (pre-dating
// the three-layer export format) never write this key, so this simply
// returns null for them — no historical comparison to show, not an error.
function consumeImportedAssessmentSnapshot(urlParams) {
    if (!urlParams || urlParams.get('carryForward') !== '1') return null;
    const raw = sessionStorage.getItem(IMPORTED_ASSESSMENT_SNAPSHOT_KEY);
    sessionStorage.removeItem(IMPORTED_ASSESSMENT_SNAPSHOT_KEY);
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw);
        return (parsed && typeof parsed === 'object') ? parsed : null;
    } catch (err) {
        return null;
    }
}

// Consumes the GENERIC carry-forward stash exactly once, gated on an
// explicit ?carryForward=1 flag — not just "a stash happens to exist" — so
// an abandoned rescan or a leftover stash from an earlier tab can never
// silently reattach to an unrelated later session. Returns sanitized
// entries (possibly empty), and always removes the stash from storage.
function consumeGenericCarryForward(urlParams) {
    if (!urlParams || urlParams.get('carryForward') !== '1') return [];
    const raw = sessionStorage.getItem(CARRY_FORWARD_KEY);
    sessionStorage.removeItem(CARRY_FORWARD_KEY);
    if (!raw) return [];
    try {
        const stash = JSON.parse(raw);
        if (!stash || !Array.isArray(stash.entries)) return [];
        const seen = new Set();
        const out = [];
        for (const rawEntry of stash.entries) {
            const entry = sanitizeImportedEntry(rawEntry);
            if (!entry) continue;
            const key = entry.app_id || normalizeAppName(entry.app_name);
            if (seen.has(key)) continue; // duplicate within the file — keep the first
            seen.add(key);
            out.push(entry);
        }
        return out;
    } catch (err) {
        return []; // corrupt stash — ignore rather than crash the page
    }
}

// The one function both Results and Workspace call on load to obtain the
// current Personal Context for a session: prefer the session-scoped stash
// (an in-progress or previously-Recalculated assessment); if empty, consume
// the generic carry-forward stash (a fresh Rescan/Import landing) and seed
// the session-scoped stash from it so later trips in this same session use
// it directly. Returns a Map keyed by decisionKey/deviceDecisionKey.
function loadPersonalContext(sessionId, urlParams) {
    const map = new Map();
    let entries = readSessionContext(sessionId);
    if (entries.length === 0) {
        entries = consumeGenericCarryForward(urlParams);
        if (entries.length > 0) writeSessionContext(sessionId, entries);
    }
    for (const entry of entries) {
        const key = entry.app_id || normalizeAppName(entry.app_name);
        map.set(key, entry);
    }
    return map;
}

function personalContextToEntries(map) {
    return Array.from(map.values()).map((e) => ({
        app_name: e.app_name,
        app_id: e.app_id || undefined,
        decision: e.decision,
        verified_status: e.decision === 'personally_verified' ? e.verified_status : undefined,
        critical_to_me: e.critical_to_me || undefined,
        note: e.note || undefined,
        researched_at: e.researched_at,
        is_device: e.is_device || undefined,
    }));
}

// ─────────────────────────────────────────
//  Recommendation synthesis (apps only — devices never feed the score,
//  by design; see CLAUDE.md, Device/driver detection)
// ─────────────────────────────────────────

function readinessLabelFor(score) {
    if (score >= 80) return { label: 'Good Fit', color: '#10b981' };
    if (score >= 50) return { label: 'Workable with Caveats', color: '#f59e0b' };
    return { label: 'Not Recommended Yet', color: '#ef4444' };
}

const CONFIDENCE_TIERS = ['Very Limited Data', 'Limited Data', 'Moderate Confidence', 'High Confidence'];
function confidenceTierIndex(pct) {
    if (pct >= 80) return 3;
    if (pct >= 50) return 2;
    if (pct >= 25) return 1;
    return 0;
}

// Light Assessment population — see the block below classifyAssessmentItem
// for the full heuristic and rationale. Referenced here because Light's
// population filter is applied inside the synthesis loop itself: a
// deprioritized app contributes nothing to Score/Confidence/Primary Reasons
// until the user promotes it ("This matters to me" → critical_to_me), the
// same flag this function already uses for weighting elsewhere. Only
// scan_mode === 'quick' (Light) ever deprioritizes; Standard/Advanced never do.
// UserAssist thresholds — interpretation lives here, deliberately, not in
// the scanner (see CLAUDE.md, UserAssist Enrichment milestone). The scanner
// sends raw launch_count/days_since_last_launch; these two small functions
// are the ONLY place that turns those numbers into a judgment, so the bar
// can be retuned later without a new scanner release. Neither raw number is
// ever rendered directly — only the interpreted phrases below are.
function hasFrequentUserAssistLaunches(app) {
    return typeof app.launch_count === 'number' && app.launch_count >= 3;
}
function hasRecentUserAssistLaunch(app) {
    return typeof app.days_since_last_launch === 'number' && app.days_since_last_launch <= 30;
}

// Default-handler evidence — see CLAUDE.md, Default-Handler Evidence
// addendum. Windows doesn't reliably distinguish a deliberate user choice
// from an installer-set default with equal confidence for every entry, so
// this is treated as modest/corroborating, same tier as a Start Menu entry,
// not promoted to the same weight as running/startup/pinned.
function hasMeaningfulDefaultHandler(app) {
    return typeof app.default_handler_count === 'number' && app.default_handler_count > 0;
}
function defaultHandlerEvidenceLines(app) {
    if (!hasMeaningfulDefaultHandler(app)) return [];
    const categories = Array.isArray(app.default_handler_categories) ? app.default_handler_categories : [];
    const labels = { browser: 'Default handler for web links', mail: 'Default handler for email' };
    const lines = categories.map((c) => labels[c] || `Default handler (${c})`);
    return lines.length > 0 ? lines : ['Default handler for a checked association'];
}

function isLightPriorityApp(app) {
    return !!(app.is_running || app.is_startup || app.recently_used || app.is_pinned_taskbar
        || hasFrequentUserAssistLaunches(app) || hasRecentUserAssistLaunch(app) || hasMeaningfulDefaultHandler(app));
}

// Standard's material bar is deliberately looser than Light's, never equal
// to it — Standard's whole premise is "broader app coverage" (CLAUDE.md,
// Assessment levels), but "broader" still isn't "everything with a catalog
// match, no matter how thin its footprint." A real Start Menu entry (an
// actual installed program with a launcher, not just a bare registry row)
// clears it, on top of everything Light already counts.
function isStandardPriorityApp(app) {
    return !!(app.has_start_menu_entry || isLightPriorityApp(app));
}

// Deprioritizes an app from the SCORING/material population for Light and
// Standard alike — Advanced never deprioritizes (CLAUDE.md: "maximum
// visibility — every app... exposed"). Different thresholds per level, same
// mechanism: excluded from Score/Confidence/materialCount, but still fully
// visible and promotable ("This matters to me" / critical_to_me always
// overrides) — see the "Not Currently Prioritized" section on Results/
// Workspace, which now applies under Standard too, not just Light.
function isDeprioritized(app, decision, scanMode) {
    if (decision && decision.critical_to_me) return false;
    if (scanMode === 'quick') return !isLightPriorityApp(app);
    if (scanMode === 'standard') return !isStandardPriorityApp(app);
    return false; // full/advanced — everything stays in the scoring population
}

// The one canonical per-app classification. Every UI surface — Report
// tables/counts/badges, Workspace grouping/badges, Score, Confidence,
// Primary Reasons, Deserves Attention, Already Considered, Not Currently
// Prioritized, Background/Platform sections — must derive its bucket and
// background status from THIS, never re-derive effectiveBucketFor()/
// isBackgroundApp() independently. That independent re-derivation (several
// call sites each computing their own answer) was the root cause of raw
// catalog status silently contradicting effective assessment treatment in
// the UI — see CLAUDE.md, Canonical Effective Status milestone. Apps only
// (native/emulated/unsupported/unknown buckets) — devices have no bucket
// concept and are classified separately (isLikelyNative()).
function classifyPopulation(results, personalContext) {
    const allApps = [];
    ['native', 'emulated', 'unsupported', 'unknown'].forEach((bucket) => {
        (results[bucket] || []).forEach((app) => allApps.push({ app, bucket }));
    });
    return allApps.map(({ app, bucket }) => {
        const decision = personalContext.get(decisionKey(app)) || null;
        const effectiveBucket = effectiveBucketFor(app, bucket, decision, allApps);
        const isBackground = isBackgroundApp(app, decision);
        return { app, rawBucket: bucket, effectiveBucket, isBackground, decision };
    });
}

// Weighted, decision-adjusted synthesis. Reuses the exact score-formula SHAPE
// classifyApps() already uses (native=100, (emulated+unknown)=60,
// unsupported=-20, weighted average), generalized from raw bucket counts to
// per-app weighted contributions — not a new algorithm invented from scratch.
// Entirely client-side: this is the one place personal (never-persisted)
// decision state and catalog readiness data actually meet.
function computeSynthesis(results, personalContext) {
    const scanMode = results.scan_mode;
    const classified = classifyPopulation(results, personalContext);

    let weightedNumerator = 0;
    let weightedTotal = 0;
    let knownWeighted = 0;
    let excludedCount = 0;
    let deprioritizedCount = 0;
    const deprioritized = [];
    let nativeCount = 0;
    // Confidently-detected browser-hosted PWAs (effectiveBucket === 'supported')
    // — tracked separately from nativeCount so the explanation sentence never
    // claims a browser-hosted app "runs natively," even though it contributes
    // the same 100 points (a genuinely resolved, positive compatibility fact).
    let supportedCount = 0;
    let unresolvedCount = 0;
    let unresolvedCriticalCount = 0;
    let verifiedCount = 0;
    let waitingCount = 0;
    // "The catalog supports the assessment — it does not become the
    // assessment." materialCount is what actually drove today's
    // recommendation; backgroundCount is Microsoft platform/shell software
    // and browser-hosted PWAs that stayed in a background/reference role
    // (see isBackgroundApp()) — both counted here so the Report can state
    // the distinction honestly instead of presenting a full inventory as
    // if every item were an equal decision driver.
    let materialCount = 0;
    let backgroundCount = 0;

    for (const { app, effectiveBucket, isBackground: appIsBackground, decision } of classified) {
        const decisionValue = decision ? decision.decision : null;

        if (decisionValue === 'no_longer_use') {
            excludedCount++;
            continue;
        }

        // Background status is a structural TYPE fact (Microsoft platform/
        // shell AppX software, browser-hosted PWAs) that holds at every
        // assessment level — checked BEFORE deprioritization, so a
        // background app always counts as background, never gets folded
        // into Not Currently Prioritized just because it also happens to
        // lack Light/Standard footprint evidence. Deprioritization (the
        // Light/Standard footprint gate) only ever applies to genuinely
        // non-background apps. "This matters to me" (critical_to_me) is the
        // one-click override, checked inside isDeprioritized().
        if (!appIsBackground && isDeprioritized(app, decision, scanMode)) {
            deprioritizedCount++;
            deprioritized.push({ app, bucket: effectiveBucket });
            continue;
        }

        const isKnown = effectiveBucket !== 'unknown';
        if (decisionValue === 'personally_verified' && decision.verified_status) {
            verifiedCount++;
        }

        // A structural TYPE verdict, independent of whether the bucket
        // ended up resolved — Microsoft platform/shell AppX software and
        // browser-hosted PWAs stay background-weighted even when the
        // catalog does have a real native/emulated/unsupported verdict for
        // them, since the whole point is that this kind of software rarely
        // drives a purchase decision either way. hasBackgroundOverride
        // (critical_to_me / personally_verified / deliberate-use evidence)
        // is the one way out, and it already applies per-app, never a type.
        if (appIsBackground) backgroundCount++; else materialCount++;

        let weight = 1.0;
        if (decisionValue === 'doesnt_matter') weight *= DOESNT_MATTER_WEIGHT;
        if (appIsBackground) weight *= BACKGROUND_WEIGHT;
        if (decision && decision.critical_to_me) weight *= CRITICAL_WEIGHT_MULTIPLIER;

        if (effectiveBucket === 'native') nativeCount++;
        if (effectiveBucket === 'supported') supportedCount++;
        if (decisionValue === 'waiting_for_vendor') waitingCount++;

        const points = (effectiveBucket === 'native' || effectiveBucket === 'supported') ? 100
            : effectiveBucket === 'unsupported' ? -20
                : 60; // emulated + unknown, matches classifyApps() exactly

        weightedNumerator += points * weight;
        weightedTotal += weight;
        if (isKnown) {
            knownWeighted += weight;
        } else if (!appIsBackground) {
            // Background-typed unresolved apps are deliberately excluded
            // from this count — at BACKGROUND_WEIGHT they barely move
            // Confidence, and the "N unresolved apps are holding back a
            // higher confidence rating" sentence below would overstate
            // their real impact if it counted them at face value.
            unresolvedCount++;
            if (decision && decision.critical_to_me) unresolvedCriticalCount++;
        }
    }

    if (weightedTotal === 0) {
        return { empty: true, excludedCount, deprioritizedCount, deprioritized, totalAppCount: classified.length, countedTotal: 0, materialCount: 0, backgroundCount: 0 };
    }

    const score = Math.round((weightedNumerator / (weightedTotal * 100)) * 100);
    const readiness = readinessLabelFor(score);

    const confidencePct = Math.round((knownWeighted / weightedTotal) * 100);
    let tierIdx = confidenceTierIndex(confidencePct);
    // A worried buyer's confidence should depend more on the apps they said
    // matter most — a simple, explainable rule, not another weighted term.
    if (unresolvedCriticalCount > 0 && tierIdx > 0) tierIdx -= 1;
    const confidenceLabel = CONFIDENCE_TIERS[tierIdx];
    const confidenceColor = tierIdx >= 3 ? '#10b981' : tierIdx >= 2 ? '#f59e0b' : '#ef4444';

    // Explanation is template-filled from the same counts that drove the numbers
    // above — never free-form generation — so the "why" is always traceable.
    // nativeCount/countedTotal are both counted INSIDE the loop above (not read
    // from results.native.length) so a no_longer_use or Light-deprioritized
    // native app is never silently counted in a sentence describing what's
    // actually driving the number.
    const parts = [];
    const countedTotal = classified.length - excludedCount - deprioritizedCount;
    parts.push(`${nativeCount} of ${countedTotal} app${countedTotal === 1 ? '' : 's'} run${countedTotal === 1 ? 's' : ''} natively${verifiedCount > 0 ? `, including ${verifiedCount} you personally verified` : ''}`);
    if (supportedCount > 0) {
        parts.push(`${supportedCount} more ${supportedCount === 1 ? 'is' : 'are'} browser-hosted and supported through a compatible ARM64 browser`);
    }
    if (unresolvedCount > 0) {
        parts.push(`${unresolvedCount} unresolved app${unresolvedCount === 1 ? '' : 's'}${unresolvedCriticalCount > 0 ? ` (${unresolvedCriticalCount} marked critical)` : ''} ${unresolvedCount === 1 ? 'is' : 'are'} holding back a higher confidence rating`);
    }
    if (waitingCount > 0) {
        parts.push(`${waitingCount} awaiting vendor confirmation`);
    }
    // Excluding apps must never silently inflate confidence without disclosure —
    // otherwise this could read as gaming its own metric instead of reflecting
    // genuine completeness.
    if (excludedCount > 0) {
        parts.push(`${excludedCount} excluded because you said you no longer use ${excludedCount === 1 ? 'it' : 'them'}`);
    }
    if (deprioritizedCount > 0) {
        parts.push(`${deprioritizedCount} not currently prioritized by this assessment`);
    }
    const explanation = `${readiness.label}, ${confidenceLabel} — ${parts.join('; ')}.`;

    // Primary Reasons: two distinct kinds, never blended into one silent
    // list, per WORKSPACE.md's "a small, fixed set of the biggest factors
    // behind the current Recommendation" — factors that actually drove the
    // number, not merely items worth reviewing (that's the reduction
    // narrative's job, a separate list on Results).
    //
    // kind: 'score' — ranked by |weighted contribution| to the Score above,
    // the same numbers that drove it, not a separate free-form summary.
    // Native/unsupported apps dominate naturally since they carry the
    // largest per-app point swing; critical_to_me doubles their visible
    // weight here too, consistent with the score. Unknown apps aren't a
    // "reason" on their own — they're the absence of one — so they're
    // excluded; the reduction narrative on Results covers them instead.
    // Deliberately does NOT pre-filter by the raw catalog bucket — a formerly
    // Unknown app the user personally verified as native/unsupported is a
    // real reason and must be eligible here. Only the EFFECTIVE bucket
    // (after decisions apply) gets checked for "still unknown," the actual
    // "not a reason on its own" case.
    //
    // Within equal |impact| (e.g. two native apps both worth 40 points),
    // ties break by Guidance-Signal-derived importance — a currently-running
    // app is a stronger "reason this recommendation holds" than one merely
    // installed. This is Guidance Signals doing their documented job
    // (prioritization/sorting), never inclusion — every native/unsupported/
    // personally-verified app was already eligible before this tiebreak runs.
    const scoreReasons = classified
        .map(({ app, effectiveBucket, isBackground, decision }) => {
            if (decision && decision.decision === 'no_longer_use') return null;
            if (isDeprioritized(app, decision, scanMode)) return null;
            // Background software (see isBackgroundApp()) shouldn't headline
            // "why this recommendation" even when it happens to carry a big
            // raw point swing — that's exactly the noise this concept exists
            // to keep out of the curated Report.
            if (isBackground) return null;
            if (effectiveBucket === 'unknown') return null;
            const weight = (decision && decision.critical_to_me) ? CRITICAL_WEIGHT_MULTIPLIER
                : (decision && decision.decision === 'doesnt_matter') ? DOESNT_MATTER_WEIGHT : 1.0;
            const points = (effectiveBucket === 'native' || effectiveBucket === 'supported') ? 100 : effectiveBucket === 'unsupported' ? -20 : 60;
            const importanceRank = { high: 0, normal: 1, low: 2 }[defaultImportanceForApp(app).level];
            return { app, bucket: effectiveBucket, impact: Math.abs(points - 60) * weight, importanceRank, kind: 'score' };
        })
        .filter(Boolean)
        .sort((a, b) => b.impact - a.impact || a.importanceRank - b.importanceRank)
        .slice(0, 4);

    // kind: 'confidence' — apps the user explicitly marked critical_to_me
    // that are STILL unresolved (still Unknown, no personal verification).
    // These are literally what the confidence-capping rule above is
    // responding to (`if (unresolvedCriticalCount > 0 ...) tierIdx -= 1`) —
    // as material to Confidence as a native/unsupported app is to Score, so
    // they're surfaced here too rather than only in prose. Capped at 2: a
    // secondary callout, not a replacement for the score-driven list above.
    const confidenceReasons = classified
        .map(({ app, effectiveBucket, decision }) => {
            if (!decision || !decision.critical_to_me) return null;
            if (decision.decision === 'no_longer_use') return null;
            if (effectiveBucket !== 'unknown') return null;
            return { app, bucket: effectiveBucket, kind: 'confidence' };
        })
        .filter(Boolean)
        .slice(0, 2);

    const reasons = [...scoreReasons, ...confidenceReasons];

    return { empty: false, score, readiness, confidenceLabel, confidenceColor, confidencePct, explanation, reasons, deprioritizedCount, deprioritized, totalAppCount: classified.length, countedTotal, materialCount, backgroundCount, supportedCount };
}

// ─────────────────────────────────────────
//  Export / Import — three-layer format
//
//  A saved CheckMyARM file preserves three conceptually separate things,
//  never blended together:
//    1. observation_snapshot — what the scanner itself observed (facts),
//       stripped of any catalog/classification verdict. This is what lets a
//       later import be re-classified against a newer catalog/formula
//       rather than replaying a frozen old verdict forever.
//    2. personal_context — the user's own private decisions (unchanged
//       shape from before this format existed).
//    3. assessment_snapshot — the calculated result AT EXPORT TIME (frozen,
//       for historical comparison — never recomputed on import).
//  export_format_version lets a future format change migrate old files
//  safely; EXPORT_FORMAT_VERSION 1 also still accepts the pre-existing
//  decision-only shape (a bare {format_version, entries} file) as a valid,
//  personal-context-only import — nobody's already-saved file breaks.
// ─────────────────────────────────────────

const EXPORT_FORMAT_VERSION = 1;

// Deliberately an allowlist, not a blocklist — every field NOT listed here
// (arm_support, source, confidence, notes, source_url, times_matched,
// last_updated, type, min_arm_version, architectures) is a catalog/
// classification field, not a scanner observation, and must never leak into
// the observation snapshot. This is what keeps the three export layers
// actually separate instead of one blended object.
const OBSERVATION_APP_FIELDS = [
    'name', 'id', 'version', 'publisher', 'discovery_source',
    'is_running', 'is_startup', 'has_start_menu_entry', 'is_pinned_taskbar',
    'launch_count', 'days_since_last_launch', 'focus_count', 'focus_time_ms',
    'recently_used', 'default_handler_count', 'default_handler_categories',
];
const OBSERVATION_DEVICE_FIELDS = [
    'name', 'class', 'hardware_id', 'days_ago', 'is_network',
    'manufacturer', 'driver_service', 'driver_provider',
];

function pickFields(obj, fields) {
    const out = {};
    for (const f of fields) {
        if (obj[f] !== undefined) out[f] = obj[f];
    }
    return out;
}

// The scanner-observed population is reconstructed from the classified
// buckets (every classified app already carries its original scanner
// fields — mergeEntryWithApp() in scan.js spreads the scanner observation
// AFTER the catalog row, so nothing is lost) — then stripped down to the
// observation-only allowlist above so the export never smuggles a catalog
// verdict in as if it were a raw fact.
function buildObservationSnapshot(results) {
    const apps = [];
    ['native', 'emulated', 'unsupported', 'unknown', 'systemComponents'].forEach((bucket) => {
        (results[bucket] || []).forEach((app) => apps.push(pickFields(app, OBSERVATION_APP_FIELDS)));
    });
    const unlistedApps = (results.unlisted_apps || []).map((app) => pickFields(app, OBSERVATION_APP_FIELDS));
    const devices = (results.devices || []).map((d) => pickFields(d, OBSERVATION_DEVICE_FIELDS));
    return {
        scan_mode: results.scan_mode || null,
        scanner_version: results.scanner_version || null,
        payload_version: results.payload_version || null,
        system: results.system || null,
        apps,
        unlisted_apps: unlistedApps,
        devices,
    };
}

// A compact, historical record of what the Recommendation WAS — reasons are
// reduced to {app_name, app_id, bucket, kind}, not full app objects, since
// the full evidence already lives in the observation snapshot and
// duplicating it here would blur the three-layer separation this format is
// built around.
function buildAssessmentSnapshot(results, personalContext) {
    const synthesis = computeSynthesis(results, personalContext);
    const counts = {
        native: (results.native || []).length,
        emulated: (results.emulated || []).length,
        unsupported: (results.unsupported || []).length,
        unknown: (results.unknown || []).length,
        systemComponents: (results.systemComponents || []).length,
        deprioritized: synthesis.deprioritizedCount || 0,
    };
    return {
        assessment_level: results.scan_mode || null,
        empty: !!synthesis.empty,
        readiness_label: synthesis.readiness ? synthesis.readiness.label : null,
        score: synthesis.empty ? null : synthesis.score,
        confidence_label: synthesis.confidenceLabel || null,
        confidence_pct: synthesis.empty ? null : synthesis.confidencePct,
        explanation: synthesis.explanation || null,
        primary_reasons: (synthesis.reasons || []).map((r) => ({
            app_name: r.app.name, app_id: r.app.id || null, bucket: r.bucket, kind: r.kind,
        })),
        counts,
        model_version: CMA_VERSION,
        catalog_snapshot_at: results.lastScanned || null,
    };
}

function buildExportPayload(results, personalContext) {
    return {
        export_format_version: EXPORT_FORMAT_VERSION,
        exported_at: new Date().toISOString(),
        cma_version: CMA_VERSION,
        observation_snapshot: buildObservationSnapshot(results),
        personal_context: { entries: personalContextToEntries(personalContext) },
        assessment_snapshot: buildAssessmentSnapshot(results, personalContext),
    };
}

// Untrusted-file validation, same discipline as sanitizeImportedEntry above:
// allowlist fields, coerce/validate types, never let a hand-edited or
// corrupt file reach the classification call with an unexpected shape.
function sanitizeObservationApp(raw) {
    if (!raw || typeof raw !== 'object' || typeof raw.name !== 'string' || !raw.name.trim()) return null;
    const out = { name: raw.name.trim() };
    if (typeof raw.id === 'string' && raw.id.trim()) out.id = raw.id.trim();
    if (typeof raw.version === 'string') out.version = raw.version;
    if (typeof raw.publisher === 'string') out.publisher = raw.publisher;
    if (typeof raw.discovery_source === 'string') out.discovery_source = raw.discovery_source;
    for (const f of ['is_running', 'is_startup', 'has_start_menu_entry', 'is_pinned_taskbar', 'recently_used']) {
        if (typeof raw[f] === 'boolean') out[f] = raw[f];
    }
    for (const f of ['launch_count', 'days_since_last_launch', 'focus_count', 'focus_time_ms', 'default_handler_count']) {
        if (typeof raw[f] === 'number' && Number.isFinite(raw[f]) && raw[f] >= 0) out[f] = raw[f];
    }
    if (Array.isArray(raw.default_handler_categories)) {
        const cats = raw.default_handler_categories.filter((c) => typeof c === 'string' && c.trim()).map((c) => c.trim());
        if (cats.length > 0) out.default_handler_categories = cats;
    }
    return out;
}

function sanitizeObservationDevice(raw) {
    if (!raw || typeof raw !== 'object' || typeof raw.name !== 'string' || !raw.name.trim()) return null;
    const out = { name: raw.name.trim() };
    if (typeof raw.class === 'string') out.class = raw.class;
    if (typeof raw.hardware_id === 'string') out.hardware_id = raw.hardware_id;
    if (typeof raw.days_ago === 'number' && Number.isFinite(raw.days_ago) && raw.days_ago >= 0) out.days_ago = raw.days_ago;
    if (typeof raw.is_network === 'boolean') out.is_network = raw.is_network;
    if (typeof raw.manufacturer === 'string') out.manufacturer = raw.manufacturer;
    if (typeof raw.driver_service === 'string') out.driver_service = raw.driver_service;
    if (typeof raw.driver_provider === 'string') out.driver_provider = raw.driver_provider;
    return out;
}

// Top-level import validator. Recognizes two shapes: the current three-layer
// format (export_format_version present), and the older decision-only
// format (bare {format_version, entries}) — old files stay importable,
// they just carry no observation/assessment snapshot to restore.
function sanitizeExportPayload(parsed) {
    if (!parsed || typeof parsed !== 'object') return null;

    if (typeof parsed.export_format_version === 'number') {
        const obs = parsed.observation_snapshot;
        const apps = Array.isArray(obs && obs.apps) ? obs.apps.map(sanitizeObservationApp).filter(Boolean) : [];
        const unlistedApps = Array.isArray(obs && obs.unlisted_apps) ? obs.unlisted_apps.map(sanitizeObservationApp).filter(Boolean) : [];
        const devices = Array.isArray(obs && obs.devices) ? obs.devices.map(sanitizeObservationDevice).filter(Boolean) : [];
        const entriesRaw = (parsed.personal_context && Array.isArray(parsed.personal_context.entries)) ? parsed.personal_context.entries : [];
        const entries = entriesRaw.map(sanitizeImportedEntry).filter(Boolean);
        if (apps.length === 0 && entries.length === 0) return null;
        return {
            formatVersion: parsed.export_format_version,
            scanMode: (obs && typeof obs.scan_mode === 'string') ? obs.scan_mode : null,
            scannerVersion: (obs && typeof obs.scanner_version === 'string') ? obs.scanner_version : null,
            apps, unlistedApps, devices, entries,
            assessmentSnapshot: (parsed.assessment_snapshot && typeof parsed.assessment_snapshot === 'object') ? parsed.assessment_snapshot : null,
        };
    }

    // Legacy decision-only format — no observation/assessment snapshot.
    if (Array.isArray(parsed.entries) && parsed.entries.length > 0) {
        const entries = parsed.entries.map(sanitizeImportedEntry).filter(Boolean);
        if (entries.length === 0) return null;
        return { formatVersion: 0, scanMode: null, scannerVersion: null, apps: [], unlistedApps: [], devices: [], entries, assessmentSnapshot: null };
    }

    return null;
}

// ─────────────────────────────────────────
//  Priority-first classification (apps and devices)
//
//  Deliberately NOT a persisted second axis — derived from the existing
//  single `decision` field plus evidence confidence. Functionally the same
//  Deserves Attention / Already Considered / Set Aside grouping WORKSPACE.md
//  describes, without doubling the data model. One assessment item per
//  entity — no clustering — matches the v1 scope in WORKSPACE.md.
// ─────────────────────────────────────────

// Free/cheap Guidance-Signal-informed default + a short human-readable
// reason — the mechanism behind "most of the work is already done" being
// literally true, not just how it's framed.
function defaultImportanceForApp(app) {
    if (app.is_running) return { level: 'high', reason: 'Currently running' };
    if (app.is_startup) return { level: 'high', reason: 'Starts automatically with Windows' };
    if (app.is_pinned_taskbar) return { level: 'high', reason: 'Pinned to your taskbar' };
    if (hasFrequentUserAssistLaunches(app)) return { level: 'high', reason: 'Frequently launched' };
    if (hasRecentUserAssistLaunch(app)) return { level: 'normal', reason: 'Used recently' };
    if (hasMeaningfulDefaultHandler(app)) {
        const lines = defaultHandlerEvidenceLines(app);
        return { level: 'normal', reason: lines[0] || 'Default handler for a checked association' };
    }
    if (app.has_start_menu_entry) return { level: 'normal', reason: 'Has a Start Menu entry' };
    return { level: 'low', reason: null };
}

// Deeper Research Mode / Advanced-only presentation: every UserAssist-backed
// fact that applies, not just the single winner defaultImportanceForApp()
// picks above — an app can genuinely be both "frequently launched" and
// "used recently" at once, and Deeper Research Mode is where that fuller
// picture belongs. Raw launch_count/days_since_last_launch never appear in
// either list — only these interpreted phrases do.
function userAssistEvidenceLines(app) {
    const lines = [];
    if (hasFrequentUserAssistLaunches(app)) lines.push('Launched repeatedly through Windows');
    if (hasRecentUserAssistLaunch(app)) lines.push('Used recently');
    return lines;
}

// Experimental threshold, deliberately conservative and separate from the
// UserAssist launch/recency thresholds above — Focus Count/Time are raw,
// unvalidated evidence (see CLAUDE.md, UserAssist Enrichment milestone,
// Focus Fields addendum). This exists only so the evidence stack can name
// the fact plainly ("Focused when open") without pretending to know exactly
// how much focus time is meaningful; it deliberately never contributes to
// isLightPriorityApp() / defaultImportanceForApp() / computeSynthesis().
function hasExperimentalFocusEvidence(app) {
    return typeof app.focus_time_ms === 'number' && app.focus_time_ms >= 60000; // >= 1 minute — filters pure noise only
}

// The full Importance Evidence stack — every independently-corroborating
// fact currently available for this app, accumulated rather than reduced to
// one winner. This is what Deeper Research Mode / Advanced detail shows
// (see evidenceDetailHtml() in workspace.html); the ordinary Light/Standard
// experience keeps using defaultImportanceForApp()'s single reason chip,
// unchanged. No single line here determines importance by itself — that's
// the whole point of showing the stack instead of a number.
function importanceEvidenceStack(app, decision) {
    const lines = [];
    if (app.is_running) lines.push('Currently running');
    if (app.is_startup) lines.push('Starts with Windows');
    if (app.is_pinned_taskbar) lines.push('Pinned to your taskbar');
    lines.push(...userAssistEvidenceLines(app));
    if (hasExperimentalFocusEvidence(app)) lines.push('Focused when open (experimental)');
    if (app.recently_used && !app.is_running) lines.push('Recently used (Windows Prefetch)');
    if (app.discovery_source === 'appx') lines.push('Store or PWA application');
    if (typeof hasMeaningfulDefaultHandler === 'function' && hasMeaningfulDefaultHandler(app)) {
        lines.push(...defaultHandlerEvidenceLines(app));
    }
    if (app.has_start_menu_entry) lines.push('Has a Start Menu shortcut');
    if (decision && decision.critical_to_me) lines.push('You marked this as important');
    return lines;
}

// ─────────────────────────────────────────
//  Attention eligibility — "deserves the user's attention"
//
//  Evidence should support importance; evidence alone should not
//  automatically create importance. is_running and has_start_menu_entry are
//  the two most passive signals in the whole evidence set — true of nearly
//  any OS-shell process or Windows-inbox utility, not just a genuine
//  application a user chose and cares about (a codec extension or an
//  identity-provider helper package can be "running" and "in the Start
//  Menu" too). This gate asks a prior question before evidence gets to
//  matter at all: does this item plausibly qualify as something worth
//  independently assessing? Apps that pass are grouped/sorted by
//  defaultImportanceForApp()/importanceEvidenceStack() exactly as before;
//  apps that fail stay fully classified, scored, visible, and promotable —
//  this never touches computeSynthesis() or the compatibility bucket, only
//  where an item is grouped for attention (classifyAssessmentItem below).
// ─────────────────────────────────────────

// ─────────────────────────────────────────
//  Browser-hosted PWA detection and compatibility (used below by the
//  background classifier, and further down by effectiveBucketFor()/
//  pwaSupportedNote()).
//
//  Core product rule: a browser-hosted application (messages.google.com,
//  TripIt, etc.) has no independent Windows ARM64 binary of its own — it
//  runs entirely inside whatever browser hosts it. That's an architectural
//  fact about the APPLICATION TYPE, not a claim about any one specific
//  browser on the user's CURRENT x86/x64 machine. Chrome, Edge, Firefox,
//  and Brave all ship real ARM64-native builds today, so "this can be
//  installed or used through a compatible ARM64 browser on the future ARM
//  PC" is true for any confidently-detected browser-hosted app regardless
//  of which browser happens to be in this scan, or whether that specific
//  browser is present at all. Earlier versions of this logic tried to
//  inherit the SPECIFIC installed browser's own classified bucket ("Runs
//  inside Google Chrome — treated as Native") — that both silently reverted
//  to Unknown whenever the host browser wasn't in the scan population, and
//  implied the user must keep using that exact browser, neither of which
//  the buying-decision conclusion actually depends on. Detected via the
//  same per-user ARP Publisher string the scanner already reports for
//  Chrome/Edge-installed apps (see CLAUDE.md, Scanner Enrichment
//  milestone) — no new scanner signal needed.
// ─────────────────────────────────────────

const BROWSER_HOST_PUBLISHER_PATTERN = /^(Google\\Chrome|Microsoft\\Edge|Mozilla\\Firefox|BraveSoftware\\Brave-Browser)/i;

function isBrowserHostedPWA(app) {
    return app.discovery_source === 'arp' && typeof app.publisher === 'string' && BROWSER_HOST_PUBLISHER_PATTERN.test(app.publisher);
}

// ─────────────────────────────────────────
//  Background / reference classification
//
//  Core principle (from real post-deploy testing feedback, twice now): the
//  catalog supports the assessment — it does not become the assessment.
//  Everything the scanner and catalog find stays fully discoverable
//  (Workspace, especially Advanced); not everything needs to be surfaced as
//  if it were a candidate purchase-decision driver. Two structural TYPES of
//  software are presumed background/reference, independent of which
//  compatibility bucket they land in:
//    - Microsoft-published AppX/Store software — inbox apps, codecs, shell
//      integrations, helper/sparse packages, Windows infrastructure
//      utilities (Power Automate Desktop, Command Palette, WindowsScan,
//      PowerToys, VP9/AV1 extensions, XboxIdentityProvider, Winget.Source,
//      Solitaire, and the like).
//    - Browser-hosted PWAs (see above) — valuable observations, rarely
//      valuable assessment drivers, whether or not their bucket could be
//      inherited from their host browser.
//  This is deliberately a TYPE test (publisher/discovery_source), never a
//  per-app name list — "Evidence should support importance. Evidence alone
//  should not automatically create importance" now extends one step
//  further: a structural type of software can itself be presumed
//  background, with genuine deliberate-use evidence (or the user's own
//  explicit word about THIS app) as the one way out.
// ─────────────────────────────────────────

// Microsoft-published AppX/Store software. Deliberately publisher-based,
// not a package-ID keyword list — "is this Microsoft's own first-party
// AppX software" is the durable, principled question, not "does this
// specific name look like plumbing" (a narrower, earlier version of this
// check missed Power Automate Desktop and Command Palette for exactly this
// reason). Only ever applied to discovery_source === 'appx' entries — this
// convention has no meaning for a win32/EXE publisher, and winget/ARP
// Microsoft software (Teams, 365, Visual Studio) is deliberately NOT swept
// in here: that's real, chosen, third-party-feeling software reviewed
// separately and kept on full evidence treatment.
// Checks BOTH publisher and the package-family-name prefix, not publisher
// alone — found during validation: classifyApps()'s fuzzy name-matching can
// pair an AppX package with an unrelated third-party catalog entry, and
// mergeEntryWithApp() lets that catalog row's publisher win over the
// scanner's own reported one (a real Windows Notepad AppX package matched a
// same-named but unrelated catalog app and inherited ITS publisher). The
// package family name (app.id) is scanner-reported and never overwritten by
// the catalog merge, so it survives that failure mode.
function isMicrosoftAppxPackage(app) {
    if (app.discovery_source !== 'appx') return false;
    const publisherIsMicrosoft = typeof app.publisher === 'string' && app.publisher.toLowerCase().includes('microsoft');
    const idIsMicrosoft = typeof app.id === 'string' && /^microsoft\./i.test(app.id);
    return publisherIsMicrosoft || idIsMicrosoft;
}

// Structural TYPE check — background by nature, independent of evidence or
// which compatibility bucket the app resolved to.
function isBackgroundCandidate(app) {
    return isMicrosoftAppxPackage(app) || isBrowserHostedPWA(app);
}

// Deliberate-use evidence — signals of an actual human choice (pinned it,
// set it to start automatically, launched it repeatedly/recently through
// Explorer, made it a default handler) as distinct from the two weakest,
// most passive signals in the whole set (is_running, has_start_menu_entry),
// which are just as true of a background OS component or hosted PWA as a
// real, chosen application.
function hasDeliberateUseEvidence(app) {
    return !!(app.is_startup || app.is_pinned_taskbar || hasFrequentUserAssistLaunches(app)
        || hasRecentUserAssistLaunch(app) || hasMeaningfulDefaultHandler(app));
}

// The one way a background-typed item earns its way back to full
// treatment: real deliberate-use evidence, the user's own explicit
// verification of THIS app, or "This matters to me." Passive-only evidence
// (is_running / has_start_menu_entry alone) is deliberately NOT an
// override — that's exactly the evidence this whole concept exists to stop
// treating as sufficient on its own.
function hasBackgroundOverride(app, decision) {
    if (decision && (decision.critical_to_me || decision.decision === 'personally_verified')) return true;
    return hasDeliberateUseEvidence(app);
}

// The final verdict: should this item recede into a background/reference
// role for THIS assessment? Used identically for attention grouping
// (classifyAssessmentItem), score/confidence weighting (computeSynthesis),
// and the Report's "materially influenced" framing — one verdict, three
// consumers, so they can never silently disagree.
function isBackgroundApp(app, decision) {
    return isBackgroundCandidate(app) && !hasBackgroundOverride(app, decision);
}

// The single source of truth for "what bucket should this app actually be
// evaluated under right now" — personal verification wins first (an
// explicit human claim), then the 'supported' status for a confidently-
// detected browser-hosted PWA whose raw catalog entry is Unknown (an
// architectural fact about the app TYPE — see the section above; never
// contingent on any specific browser being present in the scan), then the
// raw catalog bucket. computeSynthesis() and every attention-grouping call
// site (report.html, workspace.html) call this so scoring and grouping can
// never silently disagree about an app's effective bucket. `allApps` is
// unused here now (kept for call-site stability — several callers already
// pass it for other purposes).
function effectiveBucketFor(app, bucket, decision, allApps) {
    if (decision && decision.decision === 'personally_verified' && decision.verified_status) {
        return decision.verified_status === 'native' ? 'native'
            : decision.verified_status === 'unsupported' ? 'unsupported' : 'emulated';
    }
    if (bucket === 'unknown' && isBrowserHostedPWA(app)) {
        return 'supported';
    }
    return bucket;
}

// A short, honest, always-visible explanation for why a browser-hosted PWA
// shows "Supported" instead of "Unknown" — additive, like the existing
// "✓ You verified" badge, never a silent override of the row's own status
// badge. Deliberately never names a specific browser or claims the
// CURRENT browser is ARM64 — the conclusion is architectural (this class
// of app doesn't need its own ARM64 binary), not a claim about today's
// x86/x64 install.
function pwaSupportedNote(app, bucket) {
    if (bucket !== 'unknown' || !isBrowserHostedPWA(app)) return null;
    return 'This browser-hosted application does not require a separate ARM64 binary. It can be installed or used through a compatible ARM64 browser on your ARM PC.';
}

function defaultImportanceForDevice(device) {
    if (device.days_ago === 0) return { level: 'high', reason: 'Currently connected' };
    if (device.days_ago !== null && device.days_ago !== undefined && device.days_ago <= 14) return { level: 'normal', reason: 'Used recently' };
    return { level: 'low', reason: null };
}

// ─────────────────────────────────────────
//  Device evidence + search links (shared so Results and Workspace can
//  never silently disagree about what "Likely native" means)
// ─────────────────────────────────────────

// MEDIA is deliberately NOT in this list — see isLikelyNative() below.
// Camera/HIDClass devices validated cleanly against real hardware
// (webcam, HID input), so they stay unconditionally "likely native."
const GENERIC_DRIVER_CLASSES = ['Camera', 'HIDClass'];
const GENERIC_DRIVER_NAME_PATTERNS = /ipp|mopria|universal print|pcl6 class driver|postscript class driver|microsoft.*class driver/i;

function isLikelyNative(device) {
    if (device.class === 'MEDIA') {
        // MEDIA covers both plain USB Audio Class devices (mic/headset —
        // genuinely Windows-inbox-driven) and professional audio
        // interfaces (often vendor ASIO drivers) — the class alone can't
        // tell these apart, so require corroborating evidence
        // (driver_provider, only collected in Standard/Full mode) before
        // claiming native. No evidence available (Quick mode, or the
        // lookup failed) means "Check", not an optimistic guess.
        return !!device.driver_provider && device.driver_provider.toLowerCase().includes('microsoft');
    }
    if (GENERIC_DRIVER_CLASSES.includes(device.class)) return true;
    return GENERIC_DRIVER_NAME_PATTERNS.test(device.name);
}

function buildDriverSearchUrl(device) {
    const query = device.manufacturer ? `${device.manufacturer} ${device.name} ARM64 driver` : `${device.name} ARM64 driver`;
    return 'https://www.google.com/search?q=' + encodeURIComponent(query);
}

function buildAppSearchUrl(appName, mode) {
    const query = mode === 'unknown'
        ? `${appName} ARM64 Windows compatibility`
        : `${appName} ARM64 native version`;
    return 'https://www.google.com/search?q=' + encodeURIComponent(query);
}

// ─────────────────────────────────────────
//  Session-aware navigation
//
//  Once an assessment session exists, it becomes the user's effective
//  "home" — navigating to an informational page should never feel like
//  leaving that assessment behind. Two halves:
//   - decorateInfoLinks(): called by report.html/workspace.html, which
//     already know their own session id synchronously — just appends
//     ?session=&level= to their outgoing links to About/Why/Privacy/How.
//   - applySessionAwareNav(): called by the informational pages themselves
//     (about/why/privacy/how-it-thinks/my-submissions), which start with NO
//     session context of their own — reads ?session= off their OWN url,
//     validates it's still a real, COMPLETE session (not missing, not
//     expired, not still mid-scan), and only then rewrites the logo/
//     back-link to point at Results, reveals a Workspace shortcut, and
//     propagates the session onto every other data-info-link on the page.
//  A missing or invalid session degrades gracefully to whatever plain
//  homepage/back-link default already sits in the page's markup — nothing
//  here ever assumes a session exists.
// ─────────────────────────────────────────

function decorateInfoLinks(sessionId, level) {
    if (!sessionId) return;
    document.querySelectorAll('[data-info-link]').forEach((a) => {
        const path = a.getAttribute('href').split('?')[0];
        a.href = path + '?session=' + encodeURIComponent(sessionId) + '&level=' + encodeURIComponent(level || '');
    });
}

// Reads ?session= off the CURRENT page's own URL and checks it against the
// server — a stale bookmark or an expired/never-finished session must never
// be presented as "your assessment," so only a status:'complete' session
// counts as valid here.
async function resolveActiveSession() {
    const urlParams = new URLSearchParams(window.location.search);
    const sid = urlParams.get('session');
    if (!sid) return null;
    const level = urlParams.get('level') || '';
    try {
        const res = await fetch('/api/session/' + encodeURIComponent(sid));
        if (!res.ok) return null;
        const data = await res.json();
        if (!data || data.status !== 'complete') return null;
        return { sessionId: sid, level };
    } catch (err) {
        return null;
    }
}

async function applySessionAwareNav() {
    const session = await resolveActiveSession();
    if (!session) return;
    const resultsHref = '/report.html?session=' + encodeURIComponent(session.sessionId) + '&level=' + encodeURIComponent(session.level) + '&origin=assessment';
    const workspaceHref = '/workspace.html?session=' + encodeURIComponent(session.sessionId) + '&level=' + encodeURIComponent(session.level);
    const logoLink = document.getElementById('nav-logo-link');
    if (logoLink) logoLink.href = resultsHref;
    const backLink = document.getElementById('nav-back-link');
    if (backLink) {
        backLink.href = resultsHref;
        backLink.textContent = '← Back to Results';
    }
    const workspaceLink = document.getElementById('nav-workspace-link');
    if (workspaceLink) {
        workspaceLink.href = workspaceHref;
        workspaceLink.style.display = '';
    }
    decorateInfoLinks(session.sessionId, session.level);
}

// bucket is only meaningful for apps ('native'|'emulated'|'unsupported'|'unknown');
// pass null for devices and supply isLikelyNativeDevice instead. `bucket`
// should already be the EFFECTIVE bucket (personal verification / PWA
// inheritance already applied via effectiveBucketFor) — callers must not
// pass the raw catalog bucket here, or an inherited/verified item can
// wrongly stay in Deserves Attention while contributing nothing to the score.
// `app` (apps only) enables the background gate below.
function classifyAssessmentItem({ decision, bucket, isLikelyNativeDevice, app }) {
    const decisionValue = decision ? decision.decision : null;

    if (decisionValue === 'doesnt_matter' || decisionValue === 'no_longer_use') {
        return 'setAside';
    }

    // For apps, "I verified this" alone (before a Verified-as status is picked)
    // is a dangling mid-flow click, not a settled decision — computeSynthesis()
    // already requires decision.verified_status before it'll override the
    // effective bucket, so the grouping here must agree or an item can leave
    // Deserves Attention while still contributing nothing to the recommendation.
    // Devices have no verified_status concept (bucket === null signals device
    // per this function's own convention), so personally_verified alone settles them.
    const isSettledVerification = decisionValue === 'personally_verified' &&
        (bucket === null || !!(decision && decision.verified_status));
    const hasSettlingDecision = isSettledVerification || decisionValue === 'waiting_for_vendor';

    if (hasSettlingDecision) {
        return 'alreadyConsidered';
    }

    // Apps only: background-typed software (Microsoft AppX platform/shell
    // software, browser-hosted PWAs — see isBackgroundApp()) recedes into
    // its own quiet, always-discoverable tier — a structural TYPE verdict,
    // checked BEFORE the resolved/unresolved check below, since background
    // software should rarely drive the recommendation regardless of
    // whether its compatibility bucket happens to be resolved. Devices
    // skip this gate entirely (bucket === null).
    if (bucket !== null && app && isBackgroundApp(app, decision)) {
        return 'background';
    }

    const evidenceIsEnough = bucket !== null
        ? (bucket !== 'unknown')
        : !!isLikelyNativeDevice;

    if (evidenceIsEnough) {
        return 'alreadyConsidered';
    }

    return 'deservesAttention';
}

// ─────────────────────────────────────────────────────────────────────────
//  Adaptive Assessment Surface — user-provided intent/workload context
//
//  Conceptual model (see CLAUDE.md-style documentation in the accompanying
//  commit): the scanner produces OBSERVATIONS (raw facts). Guidance Signals
//  plus this new user-provided context together form EVIDENCE (interpreted
//  signals). computeSynthesis() above is the ASSESSMENT layer (it turns
//  evidence into score/confidence). recommendationFor()/nextActionFor()
//  below are the RECOMMENDATION layer (advice + confidence framing, on top
//  of the assessment). Nothing here duplicates or bypasses computeSynthesis
//  — Adaptive Context never touches compatibility classification
//  (effectiveBucketFor) or the score formula. It is a second, independent
//  input the RECOMMENDATION layer reads alongside the assessment, exactly
//  the same relationship Personal Context already has to computeSynthesis.
//
//  Storage follows the exact pattern already established for Personal
//  Context (readSessionContext/writeSessionContext, above): a session-less
//  "pending" stash for the case where a user answers questions before any
//  scan exists, migrated into a session-scoped stash the first time a real
//  session id becomes available. This is deliberately NOT a new persistence
//  mechanism — same sessionStorage, same one-per-session key convention,
//  same "nothing is ever sent to the server" boundary.
// ─────────────────────────────────────────────────────────────────────────

const ADAPTIVE_CONTEXT_PENDING_KEY = 'ngpcx_adaptive_context_pending_v1';
function adaptiveContextKey(sessionId) {
    return 'ngpcx_adaptive_context_' + sessionId;
}

// Small, fixed vocabularies — modest and explicit, not an open-ended tagging
// system. Matches this codebase's standing preference (isSystemComponent,
// isMicrosoftAppxPackage) for a short, named list over a sprawling taxonomy.
const INTENDED_USE_OPTIONS = ['gaming', 'development', 'creative', 'productivity', 'web_email'];
const INTENDED_USE_LABELS = {
    gaming: 'Gaming',
    development: 'Development',
    creative: 'Creative work',
    productivity: 'Office / Productivity',
    web_email: 'Mostly web & email',
};
const RELATIONSHIP_OPTIONS = ['primary_replacement', 'secondary_travel', 'not_sure'];
const RELATIONSHIP_LABELS = {
    primary_replacement: 'Replacing my main computer',
    secondary_travel: 'A second or travel computer',
    not_sure: "I'm not sure yet",
};

function defaultAdaptiveContext() {
    return { intended_use: [], relationship: null, updated_at: null };
}

// Same discipline as sanitizeImportedEntry(): never trust stored/parsed
// JSON shape without checking it against the known vocab first.
function sanitizeAdaptiveContext(raw) {
    if (!raw || typeof raw !== 'object') return defaultAdaptiveContext();
    const intended_use = Array.isArray(raw.intended_use)
        ? raw.intended_use.filter((v) => INTENDED_USE_OPTIONS.includes(v))
        : [];
    const relationship = RELATIONSHIP_OPTIONS.includes(raw.relationship) ? raw.relationship : null;
    const updated_at = typeof raw.updated_at === 'string' ? raw.updated_at : null;
    return { intended_use, relationship, updated_at };
}

function hasAdaptiveContext(ctx) {
    return !!(ctx && (ctx.intended_use.length > 0 || ctx.relationship));
}

function loadAdaptiveContext(sessionId) {
    try {
        if (sessionId) {
            const sessionRaw = sessionStorage.getItem(adaptiveContextKey(sessionId));
            if (sessionRaw) return sanitizeAdaptiveContext(JSON.parse(sessionRaw));
        }
        const pendingRaw = sessionStorage.getItem(ADAPTIVE_CONTEXT_PENDING_KEY);
        if (pendingRaw) {
            const ctx = sanitizeAdaptiveContext(JSON.parse(pendingRaw));
            // Migrate once a session exists — mirrors loadPersonalContext()'s
            // consume-and-seed behavior for the generic carry-forward stash.
            if (sessionId && hasAdaptiveContext(ctx)) saveAdaptiveContext(sessionId, ctx);
            return ctx;
        }
    } catch (err) {
        // sessionStorage unavailable/corrupt — safe empty default.
    }
    return defaultAdaptiveContext();
}

function saveAdaptiveContext(sessionId, context) {
    const payload = JSON.stringify({
        intended_use: context.intended_use,
        relationship: context.relationship,
        updated_at: new Date().toISOString(),
    });
    try {
        if (sessionId) sessionStorage.setItem(adaptiveContextKey(sessionId), payload);
        else sessionStorage.setItem(ADAPTIVE_CONTEXT_PENDING_KEY, payload);
    } catch (err) {
        // Best-effort only — same degradation the rest of this file accepts.
    }
}

// ─────────────────────────────────────────
//  Hypothesis inference — "infer aggressively, commit conservatively."
//
//  These functions only ever produce SUGGESTIONS for the UI to pre-activate
//  a pill with; nothing here writes to Adaptive Context directly, and no
//  caller may treat a hint as if the user had confirmed it. A small, named
//  keyword list — the same "principled short list, not a sprawling
//  per-vendor table" precedent as isSystemComponent()/
//  isMicrosoftAppxPackage() — deliberately not a generalized classifier.
// ─────────────────────────────────────────
const WORKLOAD_HINT_PATTERNS = {
    gaming: /steam|epic games|battle\.net|xbox|riot vanguard|ubisoft connect|ea app|ea desktop|discord/i,
    development: /visual studio|git\b|docker|node\.js|python|jetbrains|intellij|pycharm|github desktop|windows terminal|wsl|postman/i,
    creative: /photoshop|premiere|illustrator|after effects|davinci resolve|blender|figma|lightroom|audition/i,
    productivity: /microsoft 365|outlook|excel|powerpoint|onedrive|microsoft teams|slack|zoom/i,
};

// Scans classified app names for the patterns above. Deliberately reads
// only names (already-public catalog/scanner data, same privacy tier as
// everything else this file touches) — never window titles, file paths, or
// anything the Observation Enrichment milestone's privacy design excluded.
function inferWorkloadHints(results) {
    if (!results) return [];
    const names = [];
    ['native', 'emulated', 'unsupported', 'unknown'].forEach((bucket) => {
        (results[bucket] || []).forEach((app) => { if (app && app.name) names.push(app.name); });
    });
    const haystack = names.join(' | ').toLowerCase();
    return Object.keys(WORKLOAD_HINT_PATTERNS).filter((key) => WORKLOAD_HINT_PATTERNS[key].test(haystack));
}

// A durable environmental observation (Observed Environment milestone) used
// as a relevance hint, exactly the "reserved for a future assessment layer"
// use that milestone anticipated. The scanner reports the fact
// (battery_present); the inference — and the fact that it's only ever a
// suggestion, never a conclusion — lives entirely here.
function inferRelationshipHint(results) {
    if (!results || !results.system || typeof results.system.battery_present !== 'boolean') return null;
    return results.system.battery_present === false ? 'secondary_travel' : null;
}

// ─────────────────────────────────────────
//  Assessment state — the smallest clean representation of "what kind of
//  read can we currently offer," kept deliberately separate from the
//  Recommendation taxonomy below. Three states, matching the product spec
//  exactly:
//    NO_READ       — too little evidence of any kind. Nothing to show but
//                    an invitation.
//    CONTEXTUAL    — Adaptive Context alone (workload/relationship answers)
//                    is enough for a directional CANDIDATE SUITABILITY read.
//                    No scan-backed compatibility evidence exists.
//    SCAN_BACKED   — real compatibility evidence exists (a completed scan).
//                    Governed entirely by computeSynthesis(), unchanged.
//
//  This is the code-level expression of a permanent conceptual split this
//  product must never collapse:
//    Candidate suitability  — a directional read about whether Windows on
//                              ARM broadly suits a described WORKLOAD.
//                              Based on intended use, relationship to the
//                              current machine, and stated priorities.
//                              Never a claim about any specific application
//                              or device.
//    Compatibility assessment — the existing, evidence-backed verdict
//                              (readiness score, recommendation label,
//                              confidence), based on observed applications,
//                              devices, architecture, and catalog research.
//                              Only computeSynthesis() ever produces this.
//  Candidate suitability and compatibility assessment are DIFFERENT
//  QUESTIONS with different evidence requirements — this file must never
//  merge them into one number or one vocabulary. contextualReadFor() below
//  is the ONLY place that answers the suitability question; it is
//  deliberately built without touching computeSynthesis(), effectiveBucketFor(),
//  or any compatibility bucket, and its output never feeds into
//  recommendationFor()/computeSynthesis(). See CLAUDE.md, Adaptive
//  Assessment Surface milestone, Candidate Suitability addendum.
// ─────────────────────────────────────────
const ASSESSMENT_STATE_NO_READ = 'no_read';
const ASSESSMENT_STATE_CONTEXTUAL = 'contextual';
const ASSESSMENT_STATE_SCAN_BACKED = 'scan_backed';

function determineAssessmentState({ hasSession, adaptiveContext }) {
    if (hasSession) return ASSESSMENT_STATE_SCAN_BACKED;
    if (contextualReadFor(adaptiveContext).available) return ASSESSMENT_STATE_CONTEXTUAL;
    return ASSESSMENT_STATE_NO_READ;
}

// ─────────────────────────────────────────
//  Candidate suitability — the ONE rule evaluation behind both the
//  contextual-read panel's copy AND its next-action, so the two can never
//  independently drift (previously nextActionFor() re-derived a parallel
//  copy of this same branching on its own — collapsed into this single
//  function per explicit instruction not to run two disconnected
//  recommendation engines). A modest, explicit ruleset over the 5-option
//  intended-use vocabulary — not a generalized inference engine.
//
//  Deliberately never produces a numeric score. "verdict" is qualitative
//  only (positive | uncertain) and label is a directional phrase, not a
//  percentage or a point on the Recommendation taxonomy's 5-value scale —
//  see the file-level comment above for why these must stay separate
//  vocabularies.
// ─────────────────────────────────────────
function contextualReadFor(adaptiveContext) {
    const uses = (adaptiveContext && adaptiveContext.intended_use) || [];
    if (uses.length === 0) return { available: false };

    const specialized = uses.some((u) => u === 'gaming' || u === 'development' || u === 'creative');
    const travelCompanion = adaptiveContext.relationship === 'secondary_travel';
    const onlyLightweight = uses.every((u) => u === 'productivity' || u === 'web_email');

    if (specialized) {
        return {
            available: true,
            verdict: 'uncertain',
            label: 'Depends on Your Setup',
            explanation: 'Specialized software like this varies widely in ARM readiness today — some titles and tools run great, others don’t yet. We can’t say more without looking at your actual applications.',
            nextActionKind: 'scan',
            nextActionText: 'Specialized software like this benefits substantially from a real scan — run one on the computer whose apps matter most to this decision.',
        };
    }
    if (onlyLightweight || travelCompanion) {
        return {
            available: true,
            verdict: 'positive',
            label: 'Likely a Good Candidate',
            explanation: onlyLightweight
                ? 'Your planned use relies mostly on web apps and mainstream productivity tools, which are generally well suited to Windows on ARM. We have not evaluated your current applications or devices yet.'
                : 'Since this sounds like a secondary or travel computer rather than your main machine, the bar for a good fit is lower — most everyday use cases work well on Windows on ARM. We have not evaluated your current applications or devices yet.',
            nextActionKind: 'optional-scan',
            nextActionText: 'You may already have enough for this early read. Run a scan for a full compatibility assessment, or review your answers below.',
        };
    }
    // Defensive fallback for a future workload option that is neither
    // "specialized" nor "lightweight" — unreachable with the current
    // 5-option vocabulary (every option is one or the other), kept so this
    // function fails safely rather than silently if that vocabulary grows.
    return {
        available: true,
        verdict: 'uncertain',
        label: 'Worth a Closer Look',
        explanation: 'We don’t yet have enough detail about your planned use to point in a specific direction — a scan or a bit more detail would help.',
        nextActionKind: 'optional-scan',
        nextActionText: 'A scan would sharpen this further, but based on what you’ve told us, it’s optional right now.',
    };
}

// ─────────────────────────────────────────
//  Recommendation layer — advice + confidence framing, built ONLY on top of
//  computeSynthesis()'s existing output. Reuses the current 3-tier readiness
//  label and 4-tier confidence label rather than inventing new thresholds;
//  this is a display-mapping layer, not a second scoring model.
//
//  Deliberately conservative: without real compatibility evidence (a
//  completed scan), the recommendation always stays "Too Early to Tell" —
//  Adaptive Context alone (workload/relationship answers) can produce a
//  CONTEXTUAL READ (see contextualReadFor(), above) but never changes this
//  function's output. Fabricating a compatibility verdict from workload
//  guesses alone would contradict the entire premise of this product
//  (catalog-verified evidence, not category-based guessing) — see the
//  accompanying investigation report.
// ─────────────────────────────────────────
const RECOMMENDATION_COLORS = {
    'Too Early to Tell': '#64748b',
    'Poor Fit': '#ef4444',
    'Proceed with Caution': '#f59e0b',
    'Probably a Good Fit': '#10b981',
    'Good Fit': '#10b981',
};

function recommendationFor(synthesis) {
    if (!synthesis || synthesis.empty) {
        return { label: 'Too Early to Tell', color: RECOMMENDATION_COLORS['Too Early to Tell'] };
    }
    const conf = synthesis.confidenceLabel;
    if (synthesis.readiness.label === 'Good Fit') {
        const label = (conf === 'High Confidence') ? 'Good Fit' : 'Probably a Good Fit';
        return { label, color: RECOMMENDATION_COLORS[label] };
    }
    if (synthesis.readiness.label === 'Workable with Caveats') {
        return { label: 'Proceed with Caution', color: RECOMMENDATION_COLORS['Proceed with Caution'] };
    }
    return { label: 'Poor Fit', color: RECOMMENDATION_COLORS['Poor Fit'] };
}

// ─────────────────────────────────────────
//  Recommended Next Action — a modest, explicit ruleset (per-case, not a
//  generalized next-best-action engine). Four cases, matching the product
//  spec exactly: no evidence yet; scan-first; questions-first (delegates to
//  contextualReadFor() above, the single source of truth for that branch);
//  both present.
// ─────────────────────────────────────────
function nextActionFor({ hasSession, adaptiveContext, synthesis }) {
    const hasQuestions = hasAdaptiveContext(adaptiveContext);

    if (!hasSession && !hasQuestions) {
        // Neutral — deliberately does not favor either entry path, and
        // deliberately a DIFFERENT kind from the "some questions answered
        // but not enough yet" case below, so the UI can hide the single-CTA
        // button here (no evidence yet = no one recommended action) while
        // still offering one once partial evidence exists. See CLAUDE.md,
        // Adaptive Assessment Surface milestone.
        return { kind: 'start-empty', text: 'Start a new assessment by choosing a starting point below.' };
    }

    if (hasSession && !hasQuestions) {
        // A scan can observe apps, devices, architecture, and system facts,
        // but it cannot know what you're trying to accomplish next.
        return {
            kind: 'questions',
            text: 'Tell us what you’re trying to accomplish with your next computer — a few quick questions add context a scan alone can’t.',
        };
    }

    if (hasQuestions && !hasSession) {
        const read = contextualReadFor(adaptiveContext);
        if (!read.available) {
            return { kind: 'start', text: 'A bit more detail about what you plan to use it for would help — or start with a scan.' };
        }
        return { kind: read.nextActionKind, text: read.nextActionText };
    }

    // Both present — refine the existing assessment.
    if (synthesis && !synthesis.empty && synthesis.confidenceLabel !== 'High Confidence') {
        return { kind: 'refine', text: 'Review a few items in Advanced to strengthen your confidence.' };
    }
    return { kind: 'report', text: 'Your assessment is in good shape — view the detailed report for the full picture.' };
}

// ─────────────────────────────────────────
//  Dashboard Confidence — a DIFFERENT metric from synthesis.confidencePct,
//  deliberately not the same value shown on Results/Workspace. That value
//  (synthesis.confidenceLabel/confidencePct) measures how much
//  COMPATIBILITY evidence (catalog-matched apps/devices) supports today's
//  score — it is, and stays, scan-only by construction, since there is no
//  compatibility evidence without a scan. This function answers a broader
//  dashboard question instead: "how much relevant evidence, of ANY kind,
//  currently supports today's ARM Suitability read" — a scan is still the
//  largest single contributor, but Adaptive Context (what you told us you
//  plan to do) is real, independent evidence too, and must move this
//  number even when no scan exists yet, or when the scan's own
//  compatibility confidence doesn't change.
//
//  ARM Suitability (the recommendation/read itself) and Dashboard
//  Confidence (how much evidence supports it) are computed independently
//  here — recommendationFor()/contextualReadFor() never feed into this
//  function, and this function never feeds into them. Toggling an
//  Intended Use pill can raise or lower Confidence while leaving
//  Suitability unchanged, and vice versa (e.g. a scan alone changes
//  Suitability substantially but only partially moves Confidence if
//  Intended Use is still unanswered).
//
//  A deliberately SIMPLE first model, not a final one — every weight below
//  is a small, named constant specifically so it can be retuned later
//  without touching the blending logic itself. Not claimed to be
//  statistically principled; claimed only to be monotonic (more
//  independent evidence never lowers this number, all else equal) and
//  honest (a scan remains the largest contributor, matching how much more
//  it actually reveals about real compatibility than a stated intent can).
// ─────────────────────────────────────────
const DASHBOARD_CONFIDENCE_SCAN_WEIGHT = 70; // max points contributed by a completed scan, scaled by the scan's own confidencePct
const DASHBOARD_CONFIDENCE_INTENDED_USE_WEIGHT = 20; // flat credit once at least one workload pill is selected
const DASHBOARD_CONFIDENCE_RELATIONSHIP_WEIGHT = 10; // flat credit once a relationship pill is selected

function dashboardConfidencePct({ synthesis, adaptiveContext }) {
    let pct = 0;
    if (synthesis && !synthesis.empty) {
        pct += (synthesis.confidencePct / 100) * DASHBOARD_CONFIDENCE_SCAN_WEIGHT;
    }
    const uses = (adaptiveContext && adaptiveContext.intended_use) || [];
    if (uses.length > 0) pct += DASHBOARD_CONFIDENCE_INTENDED_USE_WEIGHT;
    if (adaptiveContext && adaptiveContext.relationship) pct += DASHBOARD_CONFIDENCE_RELATIONSHIP_WEIGHT;
    return Math.round(Math.max(0, Math.min(100, pct)));
}

// A small, distinct tier vocabulary from Results/Workspace's "Limited
// Data"/"Moderate Confidence"/"High Confidence" — deliberately different
// wording (not just a different number) as a second, redundant signal that
// this is the broader dashboard metric, not the scan-only one, should the
// two ever be read side by side.
function dashboardConfidenceLabel(pct) {
    if (pct <= 0) return 'No Data Yet';
    if (pct < 30) return 'Limited Evidence';
    if (pct < 60) return 'Building Evidence';
    if (pct < 85) return 'Good Evidence';
    return 'Strong Evidence';
}
