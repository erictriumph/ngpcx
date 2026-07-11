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

// GET /api/admin/unknown-apps — sorted by frequency, most-reported first
router.get('/unknown-apps', (req, res) => {
  const apps = db.prepare(`
    SELECT name, count, last_seen FROM unknown_apps
    ORDER BY count DESC, last_seen DESC
  `).all();
  res.json({ apps });
});

// GET /api/admin/stale-apps — previously-verified apps that may need re-checking.
// Restricted to apps a real scan has actually matched (times_matched > 0) — the
// apps table also holds bulk-scraped entries (e.g. WorksOnWoA) nobody's machine
// has ever reported, and those aren't worth admin time to re-verify.
// Sorted most-seen-first, oldest-verified as the tiebreaker.
router.get('/stale-apps', (req, res) => {
  const total = db.prepare(`
    SELECT COUNT(*) AS n FROM apps
    WHERE type = 'app' AND arm_support IN ('x64-emulated', 'x86-emulated', 'unsupported')
      AND times_matched > 0
  `).get().n;

  const apps = db.prepare(`
    SELECT id, name, publisher, arm_support, source, notes, confidence, times_matched, last_updated
    FROM apps
    WHERE type = 'app' AND arm_support IN ('x64-emulated', 'x86-emulated', 'unsupported')
      AND times_matched > 0
    ORDER BY times_matched DESC, last_updated ASC
    LIMIT 100
  `).all();
  res.json({ apps, total });
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