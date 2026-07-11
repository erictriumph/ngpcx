const express = require('express');
const router = express.Router();
const db = require('../db');
const { mergeApp } = require('../scrapers/merge');

const ADMIN_SECRET = process.env.ADMIN_SECRET || 'change-me';

function requireAdminAuth(req, res, next) {
  const provided = req.headers['x-admin-secret'] || req.query.secret;
  if (provided !== ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

router.use(requireAdminAuth);

function normalize(name) {
  return (name || '').toLowerCase().replace(/[\s\-_.]/g, '');
}

// Groups all community submissions by normalized app name, for attaching a
// summary (per-status counts, total, disagreement flag) to admin queue rows.
function submissionsByNormalizedName() {
  const rows = db.prepare(`
    SELECT normalized_name, arm_support, COUNT(*) AS n
    FROM community_submissions
    GROUP BY normalized_name, arm_support
  `).all();

  const byName = {};
  for (const row of rows) {
    if (!byName[row.normalized_name]) byName[row.normalized_name] = {};
    byName[row.normalized_name][row.arm_support] = row.n;
  }

  const summaries = {};
  for (const [name, breakdown] of Object.entries(byName)) {
    const total = Object.values(breakdown).reduce((sum, n) => sum + n, 0);
    summaries[name] = { breakdown, total, disagreement: Object.keys(breakdown).length > 1 };
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
const COMMUNITY_FLAG_EXISTS = `
  EXISTS (
    SELECT 1 FROM community_submissions cs
    WHERE cs.normalized_name = REPLACE(REPLACE(REPLACE(REPLACE(LOWER(apps.name), ' ', ''), '-', ''), '_', ''), '.', '')
      AND cs.arm_support != apps.arm_support
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

module.exports = router;