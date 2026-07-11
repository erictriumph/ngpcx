const express = require('express');
const router = express.Router();
const db = require('../db');
const { mergeApp } = require('../scrapers/merge');

const VALID_STATUSES = ['native', 'x64-emulated', 'x86-emulated', 'unsupported'];
const AUTO_ACCEPT_THRESHOLD = 5;
const AUTO_ACCEPT_CONFIDENCE = 0.8;

const RATE_LIMIT_MAX = 20;
const RATE_LIMIT_WINDOW_MS = 24 * 60 * 60 * 1000;
const submissionsByIp = new Map();

function normalize(name) {
  return (name || '').toLowerCase().replace(/[\s\-_.]/g, '');
}

// Fallback layer, not the primary defense — the session tie-in below already
// bounds a single scan's submissions to however many apps it actually found.
function isRateLimited(ip) {
  const now = Date.now();
  const timestamps = (submissionsByIp.get(ip) || []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  if (timestamps.length >= RATE_LIMIT_MAX) {
    submissionsByIp.set(ip, timestamps);
    return true;
  }
  timestamps.push(now);
  submissionsByIp.set(ip, timestamps);
  return false;
}

// Auto-accepts a submission's claimed status only when the app has no
// existing apps-table row at all (filling a genuine gap) and every
// submission for it agrees. Confidence is kept below every real data
// source's floor so mergeApp()'s existing conflict resolution can never let
// this override trusted data later — same safety principle as the GitHub
// auto-lookup.
function tryAutoAccept(appName, normalizedName) {
  const existing = db.prepare(`
    SELECT id FROM apps
    WHERE REPLACE(REPLACE(REPLACE(REPLACE(LOWER(name), ' ', ''), '-', ''), '_', ''), '.', '') = ?
  `).get(normalizedName);
  if (existing) return false;

  const breakdown = db.prepare(`
    SELECT arm_support, COUNT(*) AS n FROM community_submissions
    WHERE normalized_name = ?
    GROUP BY arm_support
  `).all(normalizedName);

  if (breakdown.length !== 1 || breakdown[0].n < AUTO_ACCEPT_THRESHOLD) return false;

  const status = breakdown[0].arm_support;
  mergeApp({
    id: `community_${normalizedName}`,
    name: appName,
    arm_support: status,
    type: 'app',
    source: 'community-auto',
    notes: `Auto-accepted from ${breakdown[0].n} unanimous community reports.`,
    confidence: AUTO_ACCEPT_CONFIDENCE
  });
  db.prepare(`DELETE FROM unknown_apps WHERE name = ?`).run(appName);
  return true;
}

// POST /api/community/submit — { session_id, app_name, arm_support, notes? }
router.post('/submit', (req, res) => {
  const { session_id, app_name, arm_support, notes } = req.body;

  if (!session_id || !app_name) {
    return res.status(400).json({ error: 'session_id and app_name are required' });
  }
  if (!VALID_STATUSES.includes(arm_support)) {
    return res.status(400).json({ error: `arm_support must be one of: ${VALID_STATUSES.join(', ')}` });
  }

  if (isRateLimited(req.ip)) {
    return res.status(429).json({ error: 'Too many submissions — try again later.' });
  }

  const session = db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(session_id);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }
  if (new Date(session.expires_at) < new Date()) {
    return res.status(410).json({ error: 'Session expired' });
  }

  // Anti-abuse: you can only report on an app that actually appeared in
  // your own scan, not blind-submit for anything.
  const rawApps = session.raw_apps ? JSON.parse(session.raw_apps) : [];
  const targetNorm = normalize(app_name);
  const wasScanned = rawApps.some((a) => normalize(a.name) === targetNorm);
  if (!wasScanned) {
    return res.status(400).json({ error: 'This app was not part of your scan.' });
  }

  const already = db.prepare(`
    SELECT id FROM community_submissions WHERE app_name = ? AND session_id = ?
  `).get(app_name, session_id);
  if (already) {
    return res.json({ success: true, alreadySubmitted: true });
  }

  db.prepare(`
    INSERT INTO community_submissions (app_name, normalized_name, session_id, arm_support, notes, created_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
  `).run(app_name, targetNorm, session_id, arm_support, notes || null);

  const autoAccepted = tryAutoAccept(app_name, targetNorm);

  res.json({ success: true, autoAccepted });
});

module.exports = router;
