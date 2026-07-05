const express = require('express');
const router = express.Router();
const db = require('../db');

// POST /api/scan
// Receives a list of apps from the scanner, returns a readiness report
router.post('/scan', (req, res) => {
  const { apps, system, scan_mode } = req.body;

  if (!apps || !Array.isArray(apps)) {
    return res.status(400).json({ error: 'Invalid request - expected an apps array' });
  }

  const native = [];
  const emulated = [];
  const unsupported = [];
  const unknown = [];

  for (const app of apps) {
    // Look up this app in the database
    // Look up by Winget ID first (exact match, fastest)
    let entry = db.prepare(`
      SELECT * FROM apps WHERE LOWER(id) = LOWER(?)
    `).get(app.id || '');

    // Fall back to normalized name match
    if (!entry && app.name) {
      const normalized = app.name.toLowerCase().replace(/[\s\-_.]/g, '');
      entry = db.prepare(`
        SELECT * FROM apps 
        WHERE REPLACE(REPLACE(REPLACE(REPLACE(LOWER(name), ' ', ''), '-', ''), '_', ''), '.', '') = ?
        ORDER BY confidence DESC
        LIMIT 1
      `).get(normalized);
    }

    // Final fallback - partial name match
    if (!entry && app.name) {
      const nameLower = app.name.toLowerCase();
      entry = db.prepare(`
        SELECT * FROM apps 
        WHERE LOWER(name) LIKE ?
        ORDER BY confidence DESC
        LIMIT 1
      `).get(`%${nameLower}%`);
    }

    if (!entry) {
      unknown.push({ ...app, arm_support: 'unknown' });
      continue;
    }

    switch (entry.arm_support) {
      case 'native':
        native.push({ ...entry, ...app });
        break;
      case 'x64-emulated':
      case 'x86-emulated':
        emulated.push({ ...entry, ...app });
        break;
      case 'unsupported':
        unsupported.push({ ...entry, ...app });
        break;
      default:
        unknown.push({ ...entry, ...app });
    }
  }

  // Calculate readiness score
  const total = native.length + emulated.length + unsupported.length;
  const score = total === 0 ? 0 : Math.round(
    (native.length * 100 + emulated.length * 60 - unsupported.length * 20) /
    (total * 100) * 100
  );

  const report = {
    score,
    scan_mode: scan_mode || 'unknown',
    system: system || null,
    devices: req.body.devices || [],
    native,
    emulated,
    unsupported,
    unknown,
    lastScanned: new Date().toISOString()
  };

  // If a session ID was provided, store results
  const sessionId = req.body.session_id;
  if (sessionId) {
    const result = db.prepare(`
      UPDATE sessions SET status = 'complete', results = ?
      WHERE id = ?
    `).run(JSON.stringify(report), sessionId);
  }

  res.json(report);
});

module.exports = router;