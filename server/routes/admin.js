const express = require('express');
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

  const id = `admin_${name.toLowerCase().replace(/[^a-z0-9]/g, '_')}`;

  mergeApp({
    id,
    name,
    arm_support: resolvedType === 'system' ? 'unknown' : arm_support,
    type: resolvedType,
    source: 'admin',
    notes: notes || (resolvedType === 'system'
      ? 'Marked as system component by NGPCX admin'
      : 'Manually verified by NGPCX admin'),
    confidence: 1.0
  });

  db.prepare(`DELETE FROM unknown_apps WHERE name = ?`).run(name);

  res.json({ success: true, type: resolvedType });
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

  res.json({
    pendingResearcherRequests,
    unknownApps,
    staleEntries,
    communityFindingsNeedingAttention,
    authenticatedUsers,
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