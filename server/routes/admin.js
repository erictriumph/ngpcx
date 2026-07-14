const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const db = require('../db');
const { mergeApp } = require('../scrapers/merge');
const { requireAdmin, requireResearcherOrAdmin } = require('../middleware/auth');

const ADMIN_SECRET = process.env.ADMIN_SECRET || 'change-me';
// Deliberate migration path from shared-secret to OAuth-based admin access: both stay
// active simultaneously until OAuth/sessions/Railway Volume persistence have all been
// validated in production, at which point setting this to 'false' retires the
// shared-secret path — a config change, not a code change, reversible in seconds if
// anything goes wrong. Like any process.env value, this takes effect on the next
// process restart/redeploy, not against the already-running process.
const ADMIN_SECRET_ENABLED = process.env.ADMIN_SECRET_ENABLED !== 'false';

function requireAdminAuthOrOAuth(req, res, next) {
  const provided = req.headers['x-admin-secret'] || req.query.secret;
  if (ADMIN_SECRET_ENABLED && provided === ADMIN_SECRET) {
    return next();
  }
  return requireAdmin(req, res, next);
}

// The admin secret is a strict superset of Researcher access too (it's full legacy
// admin power) — so it's checked first here as well, same as requireAdminAuthOrOAuth.
// Applied only to the specific research-related routes listed in CLAUDE.md's
// Researcher Permissions section — never a blanket router.use(), so each route's
// authorization is visible at its own definition, not inherited implicitly.
function requireResearcherAuthOrOAuth(req, res, next) {
  const provided = req.headers['x-admin-secret'] || req.query.secret;
  if (ADMIN_SECRET_ENABLED && provided === ADMIN_SECRET) {
    return next();
  }
  return requireResearcherOrAdmin(req, res, next);
}

function normalize(name) {
  return (name || '').toLowerCase().replace(/[\s\-_.]/g, '');
}

// Only rows with an identity, not superseded, count here — same predicate used by
// community.js's auto-accept gate, so admins see the same signal it acts on. Legacy
// (identity-less) and superseded rows stay visible elsewhere but never factor into
// this summary.
const ACTIVE_WITH_IDENTITY = `state = 'active' AND (anonymous_id IS NOT NULL OR user_id IS NOT NULL)`;
const ANON_WEIGHT = 1;
const AUTH_WEIGHT = 3;

// Groups all community submissions by normalized app name, for attaching a summary
// (per-status counts + weighted confidence, total, disagreement flag) to admin queue
// rows. Weighting here is purely informational — it mirrors the weight community.js's
// auto-accept uses for display, but never auto-resolves anything itself; admins still
// decide manually.
function submissionsByNormalizedName() {
  const rows = db.prepare(`
    SELECT normalized_name, arm_support,
      COUNT(*) AS n,
      SUM(CASE WHEN user_id IS NOT NULL THEN 1 ELSE 0 END) AS authenticatedN
    FROM community_submissions
    WHERE ${ACTIVE_WITH_IDENTITY}
    GROUP BY normalized_name, arm_support
  `).all();

  const byName = {};
  for (const row of rows) {
    if (!byName[row.normalized_name]) byName[row.normalized_name] = {};
    const anonymousN = row.n - row.authenticatedN;
    byName[row.normalized_name][row.arm_support] = {
      count: row.n,
      authenticated: row.authenticatedN,
      weight: anonymousN * ANON_WEIGHT + row.authenticatedN * AUTH_WEIGHT
    };
  }

  const summaries = {};
  for (const [name, breakdown] of Object.entries(byName)) {
    const total = Object.values(breakdown).reduce((sum, b) => sum + b.count, 0);
    const totalWeight = Object.values(breakdown).reduce((sum, b) => sum + b.weight, 0);
    summaries[name] = { breakdown, total, totalWeight, disagreement: Object.keys(breakdown).length > 1 };
  }
  return summaries;
}

// GET /api/admin/unknown-apps — sorted disagreement-flagged first, then by
// frequency, most-reported first
router.get('/unknown-apps', requireResearcherAuthOrOAuth, (req, res) => {
  const apps = db.prepare(`
    SELECT name, count, last_seen FROM unknown_apps
    ORDER BY count DESC, last_seen DESC
  `).all();

  const submissions = submissionsByNormalizedName();

  const enriched = apps.map((app) => ({
    ...app,
    submissions: submissions[normalize(app.name)] || null
  }));

  enriched.sort((a, b) => {
    const aFlag = a.submissions?.disagreement ? 1 : 0;
    const bFlag = b.submissions?.disagreement ? 1 : 0;
    return bFlag - aFlag;
  });

  res.json({ apps: enriched });
});

// Matches a community submission to an apps row by normalized name, flagging
// rows where the community disagrees with the current classification —
// including native apps, which the staleness gate below otherwise excludes.
// Same consensus predicate as ACTIVE_WITH_IDENTITY above, qualified with cs. for this
// correlated subquery — keep the two in sync if that predicate ever changes.
const COMMUNITY_FLAG_EXISTS = `
  EXISTS (
    SELECT 1 FROM community_submissions cs
    WHERE cs.normalized_name = REPLACE(REPLACE(REPLACE(REPLACE(LOWER(apps.name), ' ', ''), '-', ''), '_', ''), '.', '')
      AND cs.arm_support != apps.arm_support
      AND cs.state = 'active' AND (cs.anonymous_id IS NOT NULL OR cs.user_id IS NOT NULL)
  )
`;

// GET /api/admin/stale-apps — previously-verified apps that may need re-checking.
// Two ways in: (1) apps a real scan has actually matched (times_matched > 0)
// that are emulated/unsupported — the apps table also holds bulk-scraped
// entries (e.g. WorksOnWoA) nobody's machine has ever reported, not worth
// admin time; (2) any app, regardless of status or match count, that a
// community submission disagrees with — these always need a look.
// Sorted flagged-first, then most-seen-first, oldest-verified as the tiebreaker.
router.get('/stale-apps', requireResearcherAuthOrOAuth, (req, res) => {
  const total = db.prepare(`
    SELECT COUNT(*) AS n FROM apps
    WHERE type = 'app' AND (
      (arm_support IN ('x64-emulated', 'x86-emulated', 'unsupported') AND times_matched > 0)
      OR ${COMMUNITY_FLAG_EXISTS}
    )
  `).get().n;

  const apps = db.prepare(`
    SELECT id, name, publisher, arm_support, source, notes, confidence, times_matched, last_updated,
      ${COMMUNITY_FLAG_EXISTS} AS flagged
    FROM apps
    WHERE type = 'app' AND (
      (arm_support IN ('x64-emulated', 'x86-emulated', 'unsupported') AND times_matched > 0)
      OR ${COMMUNITY_FLAG_EXISTS}
    )
    ORDER BY flagged DESC, times_matched DESC, last_updated ASC
    LIMIT 100
  `).all();

  const submissions = submissionsByNormalizedName();
  const enriched = apps.map((app) => ({
    ...app,
    flagged: !!app.flagged,
    submissions: submissions[normalize(app.name)] || null
  }));

  res.json({ apps: enriched, total });
});

// Resolves the identity to attribute a catalog-changing or recommendation-lifecycle
// action to. Mirrors the existing "req.user only under OAuth, never the shared secret"
// pattern already used by the researcher-request approve/decline routes above — a
// *_label fallback keeps every research_activity_log row meaningfully attributable
// even when there's no user id to attach (see CLAUDE.md, Community Review section).
function resolveActor(req) {
  if (req.user) return { id: req.user.id, label: null };
  return { id: null, label: 'shared-admin-secret' };
}

// Current catalog verdict/notes for an app name, or null if it has no apps row yet —
// used purely to capture "previous" state for research_activity_log entries.
function currentCatalogState(name) {
  const normalized = normalize(name);
  return db.prepare(`
    SELECT arm_support, notes FROM apps
    WHERE REPLACE(REPLACE(REPLACE(REPLACE(LOWER(name), ' ', ''), '-', ''), '_', ''), '.', '') = ?
    ORDER BY confidence DESC LIMIT 1
  `).get(normalized) || null;
}

function logActivity({ appName, actor, action, previous, newArmSupport, newNotes }) {
  db.prepare(`
    INSERT INTO research_activity_log
      (app_name, actor_id, actor_label, action, previous_arm_support, new_arm_support, previous_notes, new_notes, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(
    appName,
    actor.id,
    actor.label,
    action,
    previous ? previous.arm_support : null,
    newArmSupport ?? null,
    previous ? previous.notes : null,
    newNotes || null
  );
}

// The one and only path that writes a catalog verdict — direct admin/researcher
// resolutions (below) and confirmed/revised Community Review recommendations (see the
// Community Review section further down) both call this, so research_activity_log
// always captures a complete, consistent history without a second write path that could
// drift out of sync (CLAUDE.md explicitly warns about exactly this kind of duplication).
function resolveAppCatalog({ name, type, arm_support, notes, actor, action }) {
  const resolvedType = type === 'system' ? 'system' : 'app';
  const previous = currentCatalogState(name);
  const id = `admin_${name.toLowerCase().replace(/[^a-z0-9]/g, '_')}`;
  const newArmSupport = resolvedType === 'system' ? 'unknown' : arm_support;

  mergeApp({
    id,
    name,
    arm_support: newArmSupport,
    type: resolvedType,
    source: 'admin',
    notes: notes || (resolvedType === 'system'
      ? 'Marked as system component by NGPCX admin'
      : 'Manually verified by NGPCX admin'),
    confidence: 1.0
  });

  db.prepare(`DELETE FROM unknown_apps WHERE name = ?`).run(name);

  logActivity({ appName: name, actor, action, previous, newArmSupport, newNotes: notes || null });

  return { id, type: resolvedType };
}

// POST /api/admin/resolve-app — { name, type?, arm_support, notes? }
// type: 'system' marks the app as a system component (arm_support not required,
// not evaluated for compatibility). Omitted/'app' is the existing behavior.
router.post('/resolve-app', requireResearcherAuthOrOAuth, (req, res) => {
  const { name, type, arm_support, notes } = req.body;

  if (!name) {
    return res.status(400).json({ error: 'name is required' });
  }

  const resolvedType = type === 'system' ? 'system' : 'app';

  if (resolvedType === 'app') {
    const validStatuses = ['native', 'x64-emulated', 'x86-emulated', 'unsupported'];
    if (!arm_support || !validStatuses.includes(arm_support)) {
      return res.status(400).json({ error: `arm_support must be one of: ${validStatuses.join(', ')}` });
    }
  }

  const actor = resolveActor(req);
  const result = resolveAppCatalog({ name, type, arm_support, notes, actor, action: 'direct_resolve' });

  res.json({ success: true, type: result.type });
});

// DELETE /api/admin/unknown-apps/:name — remove a queue entry without recording a
// verdict. Mainly for clearing out test/junk data, not a normal resolution path.
// Community submissions referencing it are deliberately left in place (not deleted) —
// with no unknown_apps entry and no apps row, they derive to "Removed" in My
// Submissions (see community.js GET /mine), which is more honest to a contributor than
// their submission silently vanishing.
router.delete('/unknown-apps/:name', requireAdminAuthOrOAuth, (req, res) => {
  const name = req.params.name;
  db.prepare(`DELETE FROM unknown_apps WHERE name = ?`).run(name);
  res.json({ success: true });
});

// DELETE /api/admin/apps/:id — permanently remove an apps-table entry.
router.delete('/apps/:id', requireAdminAuthOrOAuth, (req, res) => {
  db.prepare(`DELETE FROM apps WHERE id = ?`).run(req.params.id);
  res.json({ success: true });
});

// ---------------------------------------------------------------------------
// User management, Researcher requests, and the admin dashboard — all Admin-only.
// None of this touches sessions.raw_apps/results — contribution counts and history
// come entirely from community_submissions, per the privacy audit's boundaries.
// ---------------------------------------------------------------------------

const VALID_ROLES = ['user', 'researcher', 'admin'];

function parseId(raw) {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

// ---------------------------------------------------------------------------
// Community Review (Phase 1) — Researcher/Admin-only. Preserves three distinct
// concepts, per the design review this phase was built from:
//   - Community Findings: firsthand community_submissions rows. Reviewable here, but
//     never edited or overwritten by a Researcher — only the owner can edit their own
//     (see community.js POST /update, used from My Submissions).
//   - Researcher Recommendations: a Researcher's evaluation of that evidence. Purely
//     additive — proposing one never touches community_submissions.
//   - The Canonical Catalog (apps table): the only thing a confirmed recommendation
//     updates, via the same resolveAppCatalog() path direct resolutions use.
// ---------------------------------------------------------------------------

// Any app with at least one active, identity-bearing community submission counts as
// "useful community evidence." This single query backs both the queue endpoint and the
// dashboard summary count, so the two can never drift apart.
function buildCommunityReviewQueue() {
  const apps = db.prepare(`
    SELECT normalized_name, app_name FROM (
      SELECT normalized_name, app_name,
        ROW_NUMBER() OVER (PARTITION BY normalized_name ORDER BY created_at DESC) AS rn
      FROM community_submissions
      WHERE ${ACTIVE_WITH_IDENTITY}
    ) WHERE rn = 1
  `).all();

  const submissions = submissionsByNormalizedName();

  const catalogRows = db.prepare(`
    SELECT arm_support, notes, source, confidence,
      REPLACE(REPLACE(REPLACE(REPLACE(LOWER(name), ' ', ''), '-', ''), '_', ''), '.', '') AS normalized_name
    FROM apps
  `).all();
  const catalogByName = {};
  for (const row of catalogRows) {
    // Highest-confidence row per normalized name, mirroring findExistingId()'s ordering.
    if (!catalogByName[row.normalized_name] || row.confidence > catalogByName[row.normalized_name].confidence) {
      catalogByName[row.normalized_name] = row;
    }
  }

  const unknownRows = db.prepare(`SELECT name FROM unknown_apps`).all();
  const unknownByExactName = new Set(unknownRows.map((r) => r.name));

  const notesRows = db.prepare(`
    SELECT normalized_name FROM community_submissions
    WHERE ${ACTIVE_WITH_IDENTITY} AND notes IS NOT NULL AND TRIM(notes) != ''
    GROUP BY normalized_name
  `).all();
  const hasNotesSet = new Set(notesRows.map((r) => r.normalized_name));

  const catalogConflictRows = db.prepare(`
    SELECT DISTINCT cs.normalized_name
    FROM community_submissions cs
    JOIN apps a ON REPLACE(REPLACE(REPLACE(REPLACE(LOWER(a.name), ' ', ''), '-', ''), '_', ''), '.', '') = cs.normalized_name
    WHERE cs.state = 'active' AND (cs.anonymous_id IS NOT NULL OR cs.user_id IS NOT NULL)
      AND cs.arm_support != a.arm_support
  `).all();
  const catalogConflictSet = new Set(catalogConflictRows.map((r) => r.normalized_name));

  const pendingRecs = db.prepare(`SELECT normalized_name, id FROM researcher_recommendations WHERE status = 'pending'`).all();
  const pendingByName = {};
  for (const row of pendingRecs) pendingByName[row.normalized_name] = row.id;

  const items = apps.map(({ normalized_name, app_name }) => {
    const breakdown = submissions[normalized_name] || { breakdown: {}, total: 0, totalWeight: 0, disagreement: false };
    const catalog = catalogByName[normalized_name] || null;
    const hasNotes = hasNotesSet.has(normalized_name);
    const catalogConflict = catalogConflictSet.has(normalized_name);
    const conflict = breakdown.disagreement || catalogConflict;
    const unknownQueued = unknownByExactName.has(app_name);
    // "Unknown catalog entries with evidence" means literally still sitting in the
    // unknown_apps queue, not merely "has no apps row yet" — an app that never got
    // scanned as unrecognized by anyone (so never entered unknown_apps) but also
    // happens to lack a catalog row is a different, lower-priority situation.
    const unknownWithEvidence = unknownQueued;

    // Deterministic priority: conflicts first (either kind), then Unknown-queue
    // entries with evidence, then anything carrying Compatibility Notes, then the
    // rest — "otherwise actionable applications" from the spec.
    let priority = 0;
    if (conflict) priority = 3;
    else if (unknownWithEvidence) priority = 2;
    else if (hasNotes) priority = 1;

    return {
      app_name,
      normalized_name,
      catalog: catalog ? {
        arm_support: catalog.arm_support, source: catalog.source, confidence: catalog.confidence, notes: catalog.notes
      } : null,
      unknownQueued,
      submissions: breakdown,
      hasNotes,
      conflict,
      catalogConflict,
      unknownWithEvidence,
      pendingRecommendationId: pendingByName[normalized_name] || null,
      priority
    };
  });

  items.sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    if (b.submissions.total !== a.submissions.total) return b.submissions.total - a.submissions.total;
    return a.app_name.localeCompare(b.app_name);
  });

  return items;
}

// GET /api/admin/community-review/queue
router.get('/community-review/queue', requireResearcherAuthOrOAuth, (req, res) => {
  res.json({ items: buildCommunityReviewQueue() });
});

// GET /api/admin/community-review/app/:normalizedName — full evidence for one app.
// Findings are deliberately stripped to arm_support/notes/created_at/contributor-type
// only — no anonymous_id, user_id, session_id, or display name, per the Community
// Review privacy boundary (no email, OAuth ids, browser ids, IPs, scan inventories, or
// unrelated user history). Recommendations, by contrast, ARE attributed by display
// name — that's an internal accountability feature for Researchers/Admins, not a
// public-facing one, and matches how Researcher requests already show display names
// to Admins elsewhere in this file.
router.get('/community-review/app/:normalizedName', requireResearcherAuthOrOAuth, (req, res) => {
  const normalizedName = req.params.normalizedName;

  const submissionRows = db.prepare(`
    SELECT arm_support, notes, created_at, (user_id IS NOT NULL) AS authenticated
    FROM community_submissions
    WHERE normalized_name = ? AND ${ACTIVE_WITH_IDENTITY}
    ORDER BY created_at DESC
  `).all(normalizedName);

  if (submissionRows.length === 0) {
    return res.status(404).json({ error: 'No community evidence found for this app.' });
  }

  const appNameRow = db.prepare(`
    SELECT app_name FROM community_submissions WHERE normalized_name = ? ORDER BY created_at DESC LIMIT 1
  `).get(normalizedName);
  const appName = appNameRow.app_name;

  const catalog = db.prepare(`
    SELECT arm_support, notes, source, confidence, type, times_matched FROM apps
    WHERE REPLACE(REPLACE(REPLACE(REPLACE(LOWER(name), ' ', ''), '-', ''), '_', ''), '.', '') = ?
    ORDER BY confidence DESC LIMIT 1
  `).get(normalizedName) || null;

  const unknownQueued = !!db.prepare(`SELECT 1 FROM unknown_apps WHERE name = ?`).get(appName);

  const findings = submissionRows.map((r) => ({
    arm_support: r.arm_support,
    notes: r.notes || null,
    created_at: r.created_at,
    contributor: r.authenticated ? 'Authenticated Contributor' : 'Anonymous Contributor'
  }));

  const authenticatedCount = findings.filter((f) => f.contributor === 'Authenticated Contributor').length;
  const anonymousCount = findings.length - authenticatedCount;
  const internalConflict = new Set(findings.map((f) => f.arm_support)).size > 1;
  const catalogConflict = !!(catalog && findings.some((f) => f.arm_support !== catalog.arm_support));

  const recommendations = db.prepare(`
    SELECT r.id, r.proposed_arm_support, r.proposed_notes, r.rationale, r.status,
      r.created_at, r.reviewed_at, r.review_note, r.created_by,
      COALESCE(creator.display_name, r.created_by_label) AS created_by_display,
      COALESCE(reviewer.display_name, r.reviewed_by_label) AS reviewed_by_display
    FROM researcher_recommendations r
    LEFT JOIN users creator ON creator.id = r.created_by
    LEFT JOIN users reviewer ON reviewer.id = r.reviewed_by
    WHERE r.normalized_name = ?
    ORDER BY r.created_at DESC
  `).all(normalizedName);

  res.json({
    app_name: appName,
    normalized_name: normalizedName,
    catalog,
    unknownQueued,
    findings,
    authenticatedCount,
    anonymousCount,
    conflict: internalConflict || catalogConflict,
    recommendations
  });
});

const RECOMMENDATION_STATUSES = ['native', 'x64-emulated', 'x86-emulated', 'unsupported'];

// ---------------------------------------------------------------------------
// Stale-recommendation confirmation guard. A recommendation's proposed verdict is a
// snapshot of the Researcher's judgment at propose-time — if the underlying community
// evidence materially changes before a second reviewer acts, Confirm/Revise must not
// silently apply a verdict that no longer reflects what's actually been reported.
// ---------------------------------------------------------------------------

// A lightweight fingerprint of an app's live community evidence — NOT a copy of the
// evidence itself. Deliberately excludes contributor identity, session data, and raw
// note text (only a hash of it), per the same privacy boundary the evidence detail
// endpoint already follows.
function computeEvidenceFingerprint(normalizedName) {
  const rows = db.prepare(`
    SELECT arm_support, notes FROM community_submissions
    WHERE normalized_name = ? AND ${ACTIVE_WITH_IDENTITY}
  `).all(normalizedName);

  const statuses = [...new Set(rows.map((r) => r.arm_support))].sort();
  // currentCatalogState() re-normalizes its input internally; passing an
  // already-normalized name through is a no-op, so this is safe to reuse as-is.
  const catalog = currentCatalogState(normalizedName);
  const catalogConflict = !!(catalog && statuses.some((s) => s !== catalog.arm_support));

  const notesTexts = rows
    .map((r) => (r.notes || '').trim())
    .filter((n) => n.length > 0)
    .sort();
  // A hash, not the text — detects any addition/removal/edit of note content without
  // persisting the notes themselves as a second copy anywhere.
  const notesHash = notesTexts.length > 0
    ? crypto.createHash('sha256').update(notesTexts.join('')).digest('hex')
    : null;

  return { statuses, catalogConflict, notesHash, totalCount: rows.length };
}

// A new agreeing submission alone (same status set, same catalog-agreement, same notes)
// is NOT material — only a change to the shape of the evidence is. "Shape" means: a
// verdict appearing or disappearing from the set of distinct opinions, community/catalog
// agreement flipping, or the note content changing.
function compareEvidenceFingerprints(before, after) {
  const beforeSet = new Set(before.statuses);
  const afterSet = new Set(after.statuses);
  const newVerdicts = after.statuses.filter((s) => !beforeSet.has(s));
  const removedVerdicts = before.statuses.filter((s) => !afterSet.has(s));
  const catalogConflictChanged = before.catalogConflict !== after.catalogConflict;
  const notesChanged = before.notesHash !== after.notesHash;
  const material = newVerdicts.length > 0 || removedVerdicts.length > 0 || catalogConflictChanged || notesChanged;
  return {
    material, newVerdicts, removedVerdicts, catalogConflictChanged, notesChanged,
    submissionCountBefore: before.totalCount, submissionCountNow: after.totalCount
  };
}

function summarizeEvidenceChange(cmp) {
  const parts = [];
  if (cmp.newVerdicts.length) parts.push(`new verdict(s) reported: ${cmp.newVerdicts.join(', ')}`);
  if (cmp.removedVerdicts.length) parts.push(`verdict(s) no longer reported: ${cmp.removedVerdicts.join(', ')}`);
  if (cmp.catalogConflictChanged) parts.push('community/catalog agreement changed');
  if (cmp.notesChanged) parts.push('community notes changed');
  if (cmp.submissionCountBefore !== cmp.submissionCountNow) {
    parts.push(`${cmp.submissionCountBefore} → ${cmp.submissionCountNow} submissions`);
  }
  return parts.join('; ') || 'Evidence changed.';
}

// Returns null if there's nothing to block on (no snapshot to compare against, or
// evidence hasn't materially changed). Otherwise returns the comparison, tagged
// `blocked` (caller must return the 409) or `acknowledged` (caller may proceed, having
// recorded that the reviewer explicitly acknowledged the change).
function checkEvidenceFreshness(rec, acknowledged) {
  if (!rec.evidence_snapshot) return null;
  const before = JSON.parse(rec.evidence_snapshot);
  const after = computeEvidenceFingerprint(rec.normalized_name);
  const cmp = compareEvidenceFingerprints(before, after);
  if (!cmp.material) return null;
  return acknowledged ? { acknowledged: true, cmp } : { blocked: true, cmp };
}

// POST /api/admin/community-review/app/:normalizedName/recommend
// { app_name, proposed_arm_support, proposed_notes?, rationale? }
// Additive only — never touches community_submissions or the apps catalog. One pending
// recommendation per app at a time (see the partial unique index in db.js).
router.post('/community-review/app/:normalizedName/recommend', requireResearcherAuthOrOAuth, (req, res) => {
  const normalizedName = req.params.normalizedName;
  const { app_name, proposed_arm_support, proposed_notes, rationale } = req.body || {};

  if (!app_name) return res.status(400).json({ error: 'app_name is required' });
  if (!RECOMMENDATION_STATUSES.includes(proposed_arm_support)) {
    return res.status(400).json({ error: `proposed_arm_support must be one of: ${RECOMMENDATION_STATUSES.join(', ')}` });
  }

  const existingPending = db.prepare(`SELECT id FROM researcher_recommendations WHERE normalized_name = ? AND status = 'pending'`).get(normalizedName);
  if (existingPending) {
    return res.status(409).json({ error: 'A recommendation is already pending for this app.', recommendationId: existingPending.id });
  }

  const actor = resolveActor(req);
  const rationaleTrimmed = typeof rationale === 'string' ? rationale.trim().slice(0, 1000) || null : null;
  const notesTrimmed = typeof proposed_notes === 'string' ? proposed_notes.trim() || null : null;
  const evidenceSnapshot = JSON.stringify(computeEvidenceFingerprint(normalizedName));

  const insert = db.prepare(`
    INSERT INTO researcher_recommendations
      (app_name, normalized_name, proposed_arm_support, proposed_notes, rationale, status, created_by, created_by_label, created_at, evidence_snapshot)
    VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, datetime('now'), ?)
  `).run(app_name, normalizedName, proposed_arm_support, notesTrimmed, rationaleTrimmed, actor.id, actor.label, evidenceSnapshot);

  const previous = currentCatalogState(app_name);
  logActivity({
    appName: app_name, actor, action: 'recommendation_created',
    previous, newArmSupport: proposed_arm_support, newNotes: notesTrimmed
  });

  res.json({ success: true, id: insert.lastInsertRowid });
});

function loadPendingRecommendation(id) {
  return db.prepare(`SELECT * FROM researcher_recommendations WHERE id = ?`).get(id);
}

// "A second trusted person" is enforced here, not just implied by the UI — the creator
// of a recommendation cannot Confirm/Revise/Reject/Leave-Unresolved their own proposal.
// Only meaningful under OAuth (req.user set); the shared secret has no identity to
// compare against, same limitation already documented for ADMIN_SECRET elsewhere.
function assertNotSelfReview(req, res, rec) {
  if (req.user && rec.created_by && req.user.id === rec.created_by) {
    res.status(403).json({ error: 'A second Researcher or Admin must review this recommendation — you cannot review your own.' });
    return false;
  }
  return true;
}

// POST /api/admin/community-review/recommendations/:id/confirm
// { reviewNote?, acknowledgeEvidenceChange? }
// Applies the recommendation exactly as proposed via the shared resolveAppCatalog()
// path — the only way a Researcher Recommendation ever updates the canonical catalog.
// Blocked (409, evidenceChanged: true) if community evidence has materially changed
// since this recommendation was proposed, unless the reviewer explicitly acknowledges
// it via acknowledgeEvidenceChange: true (see checkEvidenceFreshness() above).
router.post('/community-review/recommendations/:id/confirm', requireResearcherAuthOrOAuth, (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid recommendation id' });
  const rec = loadPendingRecommendation(id);
  if (!rec) return res.status(404).json({ error: 'Recommendation not found' });
  if (rec.status !== 'pending') return res.status(409).json({ error: `Recommendation is already ${rec.status}` });
  if (!assertNotSelfReview(req, res, rec)) return;

  const acknowledged = !!(req.body && req.body.acknowledgeEvidenceChange);
  const freshness = checkEvidenceFreshness(rec, acknowledged);
  if (freshness && freshness.blocked) {
    return res.status(409).json({
      error: 'Evidence has changed since this recommendation was proposed — review the updated evidence before confirming.',
      evidenceChanged: true,
      summary: summarizeEvidenceChange(freshness.cmp),
      changes: freshness.cmp
    });
  }

  const actor = resolveActor(req);
  resolveAppCatalog({
    name: rec.app_name, type: 'app', arm_support: rec.proposed_arm_support, notes: rec.proposed_notes,
    actor, action: 'recommendation_confirmed'
  });

  let reviewNote = (req.body && req.body.reviewNote) || null;
  if (freshness && freshness.acknowledged) {
    const ackNote = `Confirmed despite evidence change: ${summarizeEvidenceChange(freshness.cmp)}`;
    reviewNote = reviewNote ? `${ackNote} — ${reviewNote}` : ackNote;
  }

  db.prepare(`
    UPDATE researcher_recommendations SET status = 'confirmed', reviewed_by = ?, reviewed_by_label = ?, reviewed_at = datetime('now'), review_note = ?
    WHERE id = ?
  `).run(actor.id, actor.label, reviewNote, id);

  res.json({ success: true, status: 'confirmed' });
});

// POST /api/admin/community-review/recommendations/:id/revise
// { proposed_arm_support, proposed_notes?, reviewNote? }
// The second reviewer adjusts the proposal and applies it in one step — a full
// propose-again/re-confirm cycle would be the "workflow engine" the spec explicitly
// asked to avoid. The activity log (via resolveAppCatalog) still captures the catalog's
// actual previous->new transition, so there's a real audit trail without a separate
// recommendation-revision-history feature (explicitly deferred, see CLAUDE.md).
router.post('/community-review/recommendations/:id/revise', requireResearcherAuthOrOAuth, (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid recommendation id' });
  const rec = loadPendingRecommendation(id);
  if (!rec) return res.status(404).json({ error: 'Recommendation not found' });
  if (rec.status !== 'pending') return res.status(409).json({ error: `Recommendation is already ${rec.status}` });
  if (!assertNotSelfReview(req, res, rec)) return;

  const { proposed_arm_support, proposed_notes, reviewNote, acknowledgeEvidenceChange } = req.body || {};
  if (!RECOMMENDATION_STATUSES.includes(proposed_arm_support)) {
    return res.status(400).json({ error: `proposed_arm_support must be one of: ${RECOMMENDATION_STATUSES.join(', ')}` });
  }
  const notesTrimmed = typeof proposed_notes === 'string' ? proposed_notes.trim() || null : null;

  const freshness = checkEvidenceFreshness(rec, !!acknowledgeEvidenceChange);
  if (freshness && freshness.blocked) {
    return res.status(409).json({
      error: 'Evidence has changed since this recommendation was proposed — review the updated evidence before revising.',
      evidenceChanged: true,
      summary: summarizeEvidenceChange(freshness.cmp),
      changes: freshness.cmp
    });
  }

  const actor = resolveActor(req);
  resolveAppCatalog({
    name: rec.app_name, type: 'app', arm_support: proposed_arm_support, notes: notesTrimmed,
    actor, action: 'recommendation_revised'
  });

  let finalReviewNote = reviewNote || null;
  if (freshness && freshness.acknowledged) {
    const ackNote = `Revised and confirmed despite evidence change: ${summarizeEvidenceChange(freshness.cmp)}`;
    finalReviewNote = finalReviewNote ? `${ackNote} — ${finalReviewNote}` : ackNote;
  }

  db.prepare(`
    UPDATE researcher_recommendations
    SET status = 'confirmed', proposed_arm_support = ?, proposed_notes = ?,
        reviewed_by = ?, reviewed_by_label = ?, reviewed_at = datetime('now'), review_note = ?
    WHERE id = ?
  `).run(proposed_arm_support, notesTrimmed, actor.id, actor.label, finalReviewNote, id);

  res.json({ success: true, status: 'confirmed', revised: true });
});

// POST /api/admin/community-review/recommendations/:id/reject — { reviewNote? }
// No catalog change, no community_submissions change — purely marks the proposal
// rejected so it stops blocking a new recommendation for the same app.
router.post('/community-review/recommendations/:id/reject', requireResearcherAuthOrOAuth, (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid recommendation id' });
  const rec = loadPendingRecommendation(id);
  if (!rec) return res.status(404).json({ error: 'Recommendation not found' });
  if (rec.status !== 'pending') return res.status(409).json({ error: `Recommendation is already ${rec.status}` });
  if (!assertNotSelfReview(req, res, rec)) return;

  const actor = resolveActor(req);
  const reviewNote = (req.body && req.body.reviewNote) || null;

  db.prepare(`
    UPDATE researcher_recommendations SET status = 'rejected', reviewed_by = ?, reviewed_by_label = ?, reviewed_at = datetime('now'), review_note = ?
    WHERE id = ?
  `).run(actor.id, actor.label, reviewNote, id);

  const previous = currentCatalogState(rec.app_name);
  logActivity({ appName: rec.app_name, actor, action: 'recommendation_rejected', previous, newArmSupport: null, newNotes: null });

  res.json({ success: true, status: 'rejected' });
});

// POST /api/admin/community-review/recommendations/:id/unresolved — { reviewNote? }
// A genuine no-decision, not a terminal state — status intentionally stays 'pending' so
// the recommendation stays actionable. reviewed_by/reviewed_at double as a lightweight
// "last looked at by" marker rather than adding a separate touch-tracking column.
router.post('/community-review/recommendations/:id/unresolved', requireResearcherAuthOrOAuth, (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid recommendation id' });
  const rec = loadPendingRecommendation(id);
  if (!rec) return res.status(404).json({ error: 'Recommendation not found' });
  if (rec.status !== 'pending') return res.status(409).json({ error: `Recommendation is already ${rec.status}` });
  if (!assertNotSelfReview(req, res, rec)) return;

  const actor = resolveActor(req);
  const reviewNote = (req.body && req.body.reviewNote) || null;

  db.prepare(`
    UPDATE researcher_recommendations SET reviewed_by = ?, reviewed_by_label = ?, reviewed_at = datetime('now'), review_note = ?
    WHERE id = ?
  `).run(actor.id, actor.label, reviewNote, id);

  const previous = currentCatalogState(rec.app_name);
  logActivity({ appName: rec.app_name, actor, action: 'recommendation_left_unresolved', previous, newArmSupport: null, newNotes: null });

  res.json({ success: true, status: 'pending', touched: true });
});

// Shared by /users and /researcher-requests — deliberately excludes provider_id,
// full scan data, IPs, tokens, sessions, cookies, and anonymous identifiers.
const SUBMISSION_COUNTS_JOIN = `
  LEFT JOIN (
    SELECT user_id, COUNT(*) AS cnt FROM community_submissions
    WHERE user_id IS NOT NULL AND state = 'active' GROUP BY user_id
  ) active_cs ON active_cs.user_id = u.id
  LEFT JOIN (
    SELECT user_id, COUNT(*) AS cnt FROM community_submissions
    WHERE user_id IS NOT NULL AND state = 'superseded' GROUP BY user_id
  ) superseded_cs ON superseded_cs.user_id = u.id
`;

// GET /api/admin/dashboard-counts — work-queue counts only, no metrics invented just
// to fill the page. Mirrors the exact predicates the linked pages themselves use, so
// the count an admin sees always matches what they find after clicking through.
router.get('/dashboard-counts', requireAdminAuthOrOAuth, (req, res) => {
  const pendingResearcherRequests = db.prepare(`SELECT COUNT(*) AS c FROM researcher_requests WHERE status = 'pending'`).get().c;
  const unknownApps = db.prepare(`SELECT COUNT(*) AS c FROM unknown_apps`).get().c;
  const staleEntries = db.prepare(`
    SELECT COUNT(*) AS c FROM apps
    WHERE type = 'app' AND (
      (arm_support IN ('x64-emulated', 'x86-emulated', 'unsupported') AND times_matched > 0)
      OR ${COMMUNITY_FLAG_EXISTS}
    )
  `).get().c;
  const communityFindingsNeedingAttention = Object.values(submissionsByNormalizedName())
    .filter((s) => s.disagreement).length;
  const authenticatedUsers = db.prepare(`SELECT COUNT(*) AS c FROM users`).get().c;

  // Reuses the exact same queue-building logic the Community Review page itself calls,
  // so this count can never drift from what's actually in the queue.
  const communityReviewQueue = buildCommunityReviewQueue();
  const communityReviewApps = communityReviewQueue.length;
  const communityReviewConflicts = communityReviewQueue.filter((i) => i.conflict).length;

  res.json({
    pendingResearcherRequests,
    unknownApps,
    staleEntries,
    communityFindingsNeedingAttention,
    authenticatedUsers,
    communityReviewApps,
    communityReviewConflicts,
  });
});

// GET /api/admin/researcher-requests — pending queue, oldest first (fair review order).
router.get('/researcher-requests', requireAdminAuthOrOAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT
      rr.id AS request_id, rr.note, rr.requested_at,
      u.id AS user_id, u.provider, u.display_name, u.created_at AS account_created_at,
      COALESCE(active_cs.cnt, 0) AS active_submissions,
      COALESCE(superseded_cs.cnt, 0) AS superseded_submissions
    FROM researcher_requests rr
    JOIN users u ON u.id = rr.user_id
    ${SUBMISSION_COUNTS_JOIN}
    WHERE rr.status = 'pending'
    ORDER BY rr.requested_at ASC, rr.id ASC
  `).all();

  res.json({ requests: rows });
});

// GET /api/admin/users/:id/submissions — lets an admin review a specific user's
// community contributions (to evaluate a Researcher request, or just spot-check)
// without ever exposing that user's scan inventory — this queries
// community_submissions only, never sessions.raw_apps/results.
router.get('/users/:id/submissions', requireAdminAuthOrOAuth, (req, res) => {
  const userId = parseId(req.params.id);
  if (!userId) return res.status(400).json({ error: 'Invalid user id' });

  const rows = db.prepare(`
    SELECT app_name, arm_support, notes, state, created_at
    FROM community_submissions
    WHERE user_id = ?
    ORDER BY created_at DESC
  `).all(userId);

  res.json({ submissions: rows });
});

// POST /api/admin/researcher-requests/:id/approve — { decisionNote? }
// Marks the request approved and grants the researcher role, atomically. The welcome
// message is driven purely by role + users.researcher_welcome_seen (see
// routes/researcher.js) — nothing further to do here to make it appear.
router.post('/researcher-requests/:id/approve', requireAdminAuthOrOAuth, (req, res) => {
  const requestId = parseId(req.params.id);
  if (!requestId) return res.status(400).json({ error: 'Invalid request id' });

  const request = db.prepare(`SELECT * FROM researcher_requests WHERE id = ?`).get(requestId);
  if (!request) return res.status(404).json({ error: 'Request not found' });
  if (request.status !== 'pending') return res.status(409).json({ error: `Request is already ${request.status}` });

  const decisionNote = (req.body && req.body.decisionNote) || null;
  // req.user only exists when authenticated via OAuth (Passport session) — the legacy
  // shared-secret path (requireAdminAuthOrOAuth's first branch) never populates it, so
  // reviewed_by is left NULL for that path rather than crashing on req.user.id.
  const reviewerId = req.user ? req.user.id : null;

  const approve = db.transaction(() => {
    db.prepare(`
      UPDATE researcher_requests SET status = 'approved', reviewed_at = datetime('now'), reviewed_by = ?, decision_note = ?
      WHERE id = ?
    `).run(reviewerId, decisionNote, requestId);
    db.prepare(`UPDATE users SET role = 'researcher' WHERE id = ?`).run(request.user_id);
  });
  approve();

  res.json({ success: true, status: 'approved' });
});

// POST /api/admin/researcher-requests/:id/decline — { decisionNote? }
// Leaves the user's role untouched — declining never disables or otherwise
// penalizes a normal user (see CLAUDE.md, Researcher request workflow).
router.post('/researcher-requests/:id/decline', requireAdminAuthOrOAuth, (req, res) => {
  const requestId = parseId(req.params.id);
  if (!requestId) return res.status(400).json({ error: 'Invalid request id' });

  const request = db.prepare(`SELECT * FROM researcher_requests WHERE id = ?`).get(requestId);
  if (!request) return res.status(404).json({ error: 'Request not found' });
  if (request.status !== 'pending') return res.status(409).json({ error: `Request is already ${request.status}` });

  const decisionNote = (req.body && req.body.decisionNote) || null;
  // See the approve route above for why this can't just be req.user.id.
  const reviewerId = req.user ? req.user.id : null;

  db.prepare(`
    UPDATE researcher_requests SET status = 'declined', reviewed_at = datetime('now'), reviewed_by = ?, decision_note = ?
    WHERE id = ?
  `).run(reviewerId, decisionNote, requestId);

  res.json({ success: true, status: 'declined' });
});

// GET /api/admin/users — default sort: active submissions desc, then account age
// asc, then id asc as a fully deterministic final tiebreaker (created_at has only
// second-resolution and can theoretically tie).
router.get('/users', requireAdminAuthOrOAuth, (req, res) => {
  const search = (req.query.q || '').trim();

  const rows = db.prepare(`
    SELECT
      u.id, u.provider, u.display_name, u.role, u.disabled, u.created_at,
      COALESCE(active_cs.cnt, 0) AS active_submissions,
      COALESCE(superseded_cs.cnt, 0) AS superseded_submissions,
      latest_rr.status AS request_status
    FROM users u
    ${SUBMISSION_COUNTS_JOIN}
    LEFT JOIN researcher_requests latest_rr ON latest_rr.id = (
      SELECT MAX(id) FROM researcher_requests WHERE user_id = u.id
    )
    WHERE (@search = '' OR LOWER(u.display_name) LIKE '%' || LOWER(@search) || '%')
    ORDER BY active_submissions DESC, u.created_at ASC, u.id ASC
  `).all({ search });

  const users = rows.map((r) => ({
    ...r,
    disabled: !!r.disabled,
    total_submissions: r.active_submissions + r.superseded_submissions,
  }));

  res.json({ users });
});

// POST /api/admin/users/:id/role — { role, confirmSelf? }
// Server-side validation only — never trusts client-hidden UI as the actual guard.
router.post('/users/:id/role', requireAdminAuthOrOAuth, (req, res) => {
  const targetId = parseId(req.params.id);
  if (!targetId) return res.status(400).json({ error: 'Invalid user id' });

  const { role, confirmSelf } = req.body || {};
  if (!VALID_ROLES.includes(role)) {
    return res.status(400).json({ error: `role must be one of: ${VALID_ROLES.join(', ')}` });
  }

  const target = db.prepare(`SELECT * FROM users WHERE id = ?`).get(targetId);
  if (!target) return res.status(404).json({ error: 'User not found' });

  // "Self" only means something when authenticated via an actual account (OAuth) — the
  // shared secret has no associated user row, so req.user is undefined and there's no
  // self-change concept to guard against in that mode.
  if (req.user && target.id === req.user.id && role !== target.role && !confirmSelf) {
    return res.status(400).json({ error: 'Changing your own role requires confirmation.', needsConfirmation: true });
  }

  // Last-active-admin guard: only blocks demoting the sole remaining active admin —
  // a disabled admin was never "active" in the first place, so demoting one is fine.
  // No transaction needed for the count-then-update below: better-sqlite3 calls are
  // synchronous and Node is single-threaded, so no other request can interleave
  // between the COUNT and the UPDATE within this handler.
  if (target.role === 'admin' && !target.disabled && role !== 'admin') {
    const activeAdmins = db.prepare(`SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND disabled = 0`).get().c;
    if (activeAdmins <= 1) {
      return res.status(400).json({ error: 'Cannot remove the last active admin.' });
    }
  }

  db.prepare(`UPDATE users SET role = ? WHERE id = ?`).run(role, targetId);

  res.json({
    success: true,
    user: { id: target.id, display_name: target.display_name, role, disabled: !!target.disabled },
  });
});

module.exports = router;