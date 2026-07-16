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

function isLightDeprioritized(app, decision, scanMode) {
    if (scanMode !== 'quick') return false;
    if (decision && decision.critical_to_me) return false;
    return !isLightPriorityApp(app);
}

// Weighted, decision-adjusted synthesis. Reuses the exact score-formula SHAPE
// classifyApps() already uses (native=100, (emulated+unknown)=60,
// unsupported=-20, weighted average), generalized from raw bucket counts to
// per-app weighted contributions — not a new algorithm invented from scratch.
// Entirely client-side: this is the one place personal (never-persisted)
// decision state and catalog readiness data actually meet.
function computeSynthesis(results, personalContext) {
    const scanMode = results.scan_mode;
    const allApps = [];
    ['native', 'emulated', 'unsupported', 'unknown'].forEach((bucket) => {
        (results[bucket] || []).forEach((app) => allApps.push({ app, bucket }));
    });

    let weightedNumerator = 0;
    let weightedTotal = 0;
    let knownWeighted = 0;
    let excludedCount = 0;
    let deprioritizedCount = 0;
    const deprioritized = [];
    let nativeCount = 0;
    let unresolvedCount = 0;
    let unresolvedCriticalCount = 0;
    let verifiedCount = 0;
    let waitingCount = 0;

    for (const { app, bucket } of allApps) {
        const decision = personalContext.get(decisionKey(app)) || null;
        const decisionValue = decision ? decision.decision : null;

        if (decisionValue === 'no_longer_use') {
            excludedCount++;
            continue;
        }

        // Light doesn't touch the evidence tables (every app the scanner
        // found still shows in its normal bucket, unchanged) — it only
        // removes low-signal apps from THIS loop, i.e., from what counts
        // toward the recommendation. "This matters to me" (critical_to_me)
        // is the one-click override, checked inside isLightDeprioritized().
        if (isLightDeprioritized(app, decision, scanMode)) {
            deprioritizedCount++;
            deprioritized.push({ app, bucket });
            continue;
        }

        let weight = 1.0;
        if (decisionValue === 'doesnt_matter') weight *= DOESNT_MATTER_WEIGHT;
        if (decision && decision.critical_to_me) weight *= CRITICAL_WEIGHT_MULTIPLIER;

        let effectiveBucket = bucket;
        let isKnown = bucket !== 'unknown';
        if (decisionValue === 'personally_verified' && decision.verified_status) {
            effectiveBucket = decision.verified_status === 'native' ? 'native'
                : decision.verified_status === 'unsupported' ? 'unsupported'
                    : 'emulated'; // x64/x86-emulated both map to the same weight bucket
            isKnown = true;
            verifiedCount++;
        }

        if (effectiveBucket === 'native') nativeCount++;
        if (decisionValue === 'waiting_for_vendor') waitingCount++;

        const points = effectiveBucket === 'native' ? 100
            : effectiveBucket === 'unsupported' ? -20
                : 60; // emulated + unknown, matches classifyApps() exactly

        weightedNumerator += points * weight;
        weightedTotal += weight;
        if (isKnown) {
            knownWeighted += weight;
        } else {
            unresolvedCount++;
            if (decision && decision.critical_to_me) unresolvedCriticalCount++;
        }
    }

    if (weightedTotal === 0) {
        return { empty: true, excludedCount, deprioritizedCount, deprioritized, totalAppCount: allApps.length, countedTotal: 0 };
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
    const countedTotal = allApps.length - excludedCount - deprioritizedCount;
    parts.push(`${nativeCount} of ${countedTotal} app${countedTotal === 1 ? '' : 's'} run${countedTotal === 1 ? 's' : ''} natively${verifiedCount > 0 ? `, including ${verifiedCount} you personally verified` : ''}`);
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
        parts.push(`${deprioritizedCount} not currently prioritized by this Light Assessment`);
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
    const scoreReasons = allApps
        .map(({ app, bucket }) => {
            const decision = personalContext.get(decisionKey(app)) || null;
            if (decision && decision.decision === 'no_longer_use') return null;
            if (isLightDeprioritized(app, decision, scanMode)) return null;
            let effectiveBucket = bucket;
            if (decision && decision.decision === 'personally_verified' && decision.verified_status) {
                effectiveBucket = decision.verified_status === 'native' ? 'native'
                    : decision.verified_status === 'unsupported' ? 'unsupported' : 'emulated';
            }
            if (effectiveBucket === 'unknown') return null;
            const weight = (decision && decision.critical_to_me) ? CRITICAL_WEIGHT_MULTIPLIER
                : (decision && decision.decision === 'doesnt_matter') ? DOESNT_MATTER_WEIGHT : 1.0;
            const points = effectiveBucket === 'native' ? 100 : effectiveBucket === 'unsupported' ? -20 : 60;
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
    const confidenceReasons = allApps
        .map(({ app, bucket }) => {
            const decision = personalContext.get(decisionKey(app)) || null;
            if (!decision || !decision.critical_to_me) return null;
            if (decision.decision === 'no_longer_use') return null;
            const isKnownNow = bucket !== 'unknown' || (decision.decision === 'personally_verified' && !!decision.verified_status);
            if (isKnownNow) return null;
            return { app, bucket, kind: 'confidence' };
        })
        .filter(Boolean)
        .slice(0, 2);

    const reasons = [...scoreReasons, ...confidenceReasons];

    return { empty: false, score, readiness, confidenceLabel, confidenceColor, confidencePct, explanation, reasons, deprioritizedCount, deprioritized, totalAppCount: allApps.length, countedTotal };
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
//  Needs Attention / Already Considered / Set Aside grouping WORKSPACE.md
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

// bucket is only meaningful for apps ('native'|'emulated'|'unsupported'|'unknown');
// pass null for devices and supply isLikelyNativeDevice instead.
function classifyAssessmentItem({ decision, bucket, isLikelyNativeDevice }) {
    const decisionValue = decision ? decision.decision : null;

    if (decisionValue === 'doesnt_matter' || decisionValue === 'no_longer_use') {
        return 'setAside';
    }

    // For apps, "I verified this" alone (before a Verified-as status is picked)
    // is a dangling mid-flow click, not a settled decision — computeSynthesis()
    // already requires decision.verified_status before it'll override the
    // effective bucket, so the grouping here must agree or an item can leave
    // Needs Attention while still contributing nothing to the recommendation.
    // Devices have no verified_status concept (bucket === null signals device
    // per this function's own convention), so personally_verified alone settles them.
    const isSettledVerification = decisionValue === 'personally_verified' &&
        (bucket === null || !!(decision && decision.verified_status));
    const hasSettlingDecision = isSettledVerification || decisionValue === 'waiting_for_vendor';
    const evidenceIsEnough = bucket !== null
        ? (bucket !== 'unknown')
        : !!isLikelyNativeDevice;

    if (hasSettlingDecision || evidenceIsEnough) {
        return 'alreadyConsidered';
    }

    return 'needsAttention';
}
