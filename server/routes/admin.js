const express = require('express');
const router = express.Router();
const db = require('../db');
const { mergeApp } = require('../scrapers/merge');
const { requireRole } = require('../middleware/auth');

const ADMIN_SECRET = process.env.ADMIN_SECRET || 'change-me';
// Deliberate migration path from shared-secret to OAuth-based admin access: both stay
// active simultaneously until OAuth/sessions/Railway Volume persistence have all been
// validated in production, at which point setting this to 'false' retires the
// shared-secret path — a config change, not a code change, reversible in seconds if
// anything goes wrong. Like any process.env value, this takes effect on the next
// process restart/redeploy, not against the already-running process.
const ADMIN_SECRET_ENABLED = process.env.ADMIN_SECRET_ENABLED !== 'false';

const requireAdminRole = requireRole('admin');

function requireAdminAuthOrOAuth(req, res, next) {
  const provided = req.headers['x-admin-secret'] || req.query.secret;
  if (ADMIN_SECRET_ENABLED && provided === ADMIN_SECRET) {
    return next();
  }
  return requireAdminRole(req, res, next);
}

router.use(requireAdminAuthOrOAuth);

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
router.get('/unknown-apps', (req, res) => {
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
router.get('/stale-apps', (req, res) => {
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
router.post('/resolve-app', (req, res) => {
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
router.delete('/unknown-apps/:name', (req, res) => {
  const name = req.params.name;
  db.prepare(`DELETE FROM unknown_apps WHERE name = ?`).run(name);
  res.json({ success: true });
});

// DELETE /api/admin/apps/:id — permanently remove an apps-table entry.
router.delete('/apps/:id', (req, res) => {
  db.prepare(`DELETE FROM apps WHERE id = ?`).run(req.params.id);
  res.json({ success: true });
});

module.exports = router;