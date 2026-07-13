const express = require('express');
const router = express.Router();
const db = require('../db');
const { mergeApp } = require('../scrapers/merge');
const { ANON_COOKIE_NAME, ensureAnonymousId } = require('../identity');

const VALID_STATUSES = ['native', 'x64-emulated', 'x86-emulated', 'unsupported'];
const AUTO_ACCEPT_CONFIDENCE = 0.8;
const AUTO_ACCEPT_MIN_AUTHENTICATED = 2;

const RATE_LIMIT_MAX = 20;
const RATE_LIMIT_WINDOW_MS = 24 * 60 * 60 * 1000;
const submissionsByIp = new Map();

// Only rows with an identity, not superseded, ever count toward consensus/weighting/
// auto-accept — pre-migration legacy rows (neither anonymous_id nor user_id) and rows
// superseded by the anon->auth migration (see db.js, community.js collision handling)
// stay visible historically but are never counted.
const ACTIVE_WITH_IDENTITY = `state = 'active' AND (anonymous_id IS NOT NULL OR user_id IS NOT NULL)`;

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

// Resolves the caller's identity for this request: an authenticated user (once Phase 2
// Passport wiring populates req.user) takes precedence; otherwise falls back to the
// anonymous cookie, provisioning one if this is the first submission from this browser.
function resolveIdentity(req, res) {
  if (req.user) return { userId: req.user.id, anonymousId: null };
  return { userId: null, anonymousId: ensureAnonymousId(req, res) };
}

// Auto-accepts a submission's claimed status only when the app has no existing apps-table
// row at all (filling a genuine gap) and every counted submission agrees. Requires at
// least two DISTINCT AUTHENTICATED contributors — anonymous submissions can never trigger
// this alone, at any count, since a cookie identity is trivially resettable (clearing
// cookies or switching browsers/devices produces a new anonymous_id) and the per-IP rate
// limit above doesn't stop one determined person from manufacturing several across a day.
// Anonymous submissions still matter: they still count toward the unanimity check (their
// disagreement still blocks acceptance) and still surface apps into admin's queue sooner.
// Confidence is kept below every real source's floor so mergeApp()'s existing conflict
// resolution can never let this override trusted data later.
function tryAutoAccept(appName, normalizedName) {
  const existing = db.prepare(`
    SELECT id FROM apps
    WHERE REPLACE(REPLACE(REPLACE(REPLACE(LOWER(name), ' ', ''), '-', ''), '_', ''), '.', '') = ?
  `).get(normalizedName);
  if (existing) return false;

  const rows = db.prepare(`
    SELECT arm_support, user_id FROM community_submissions
    WHERE normalized_name = ? AND ${ACTIVE_WITH_IDENTITY}
  `).all(normalizedName);

  if (rows.length === 0) return false;

  const statuses = new Set(rows.map((r) => r.arm_support));
  if (statuses.size !== 1) return false;

  const distinctAuthenticated = new Set(rows.filter((r) => r.user_id != null).map((r) => r.user_id));
  if (distinctAuthenticated.size < AUTO_ACCEPT_MIN_AUTHENTICATED) return false;

  const status = rows[0].arm_support;
  mergeApp({
    id: `community_${normalizedName}`,
    name: appName,
    arm_support: status,
    type: 'app',
    source: 'community-auto',
    notes: `Auto-accepted from ${rows.length} unanimous community reports (${distinctAuthenticated.size} authenticated).`,
    confidence: AUTO_ACCEPT_CONFIDENCE
  });
  db.prepare(`DELETE FROM unknown_apps WHERE name = ?`).run(appName);
  return true;
}

// POST /api/community/submit — { session_id, app_name, arm_support, notes? }
// Upserts by (identity, normalized_name): a browser or logged-in user has exactly one
// submission per app, editable, never duplicated. session_id is still required as proof
// the app actually appeared in the caller's own scan (anti-abuse), but no longer defines
// identity or uniqueness — anonymous_id/user_id do.
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

  const { userId, anonymousId } = resolveIdentity(req, res);

  const existing = userId
    ? db.prepare(`SELECT id, arm_support FROM community_submissions WHERE user_id = ? AND normalized_name = ?`).get(userId, targetNorm)
    : db.prepare(`SELECT id, arm_support FROM community_submissions WHERE anonymous_id = ? AND normalized_name = ?`).get(anonymousId, targetNorm);

  if (existing) {
    db.prepare(`
      UPDATE community_submissions SET arm_support = ?, notes = ?, state = 'active', created_at = datetime('now')
      WHERE id = ?
    `).run(arm_support, notes || null, existing.id);

    const autoAccepted = tryAutoAccept(app_name, targetNorm);
    return res.json({ success: true, updated: true, previous: existing.arm_support, autoAccepted });
  }

  db.prepare(`
    INSERT INTO community_submissions (app_name, normalized_name, session_id, anonymous_id, user_id, arm_support, notes, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(app_name, targetNorm, session_id, anonymousId, userId, arm_support, notes || null);

  const autoAccepted = tryAutoAccept(app_name, targetNorm);

  res.json({ success: true, autoAccepted });
});

// GET /api/community/mine — the caller's own submissions (anonymous cookie or logged-in
// user), with a derived display state. Read-only: never provisions a new anonymous cookie
// (a GET with no identity yet simply has nothing to show).
router.get('/mine', (req, res) => {
  const userId = req.user ? req.user.id : null;
  const anonymousId = userId ? null : (req.cookies && req.cookies[ANON_COOKIE_NAME]);

  if (!userId && !anonymousId) {
    return res.json({ submissions: [] });
  }

  const rows = db.prepare(`
    SELECT
      cs.app_name, cs.arm_support AS submitted_status, cs.notes, cs.state, cs.created_at,
      a.arm_support AS current_status,
      (ua.name IS NOT NULL) AS still_queued
    FROM community_submissions cs
    LEFT JOIN apps a ON REPLACE(REPLACE(REPLACE(REPLACE(LOWER(a.name), ' ', ''), '-', ''), '_', ''), '.', '') = cs.normalized_name
    LEFT JOIN unknown_apps ua ON ua.name = cs.app_name
    WHERE ${userId ? 'cs.user_id = ?' : 'cs.anonymous_id = ?'}
    ORDER BY cs.created_at DESC
  `).all(userId || anonymousId);

  const submissions = rows.map((row) => {
    let state;
    if (row.state === 'superseded') {
      state = 'Superseded';
    } else if (row.current_status) {
      state = row.current_status === row.submitted_status ? 'Accepted' : 'Disputed';
    } else if (row.still_queued) {
      state = 'Pending';
    } else {
      state = 'Removed';
    }

    return {
      app_name: row.app_name,
      submitted_status: row.submitted_status,
      notes: row.notes || null,
      current_status: row.current_status || null,
      state,
      created_at: row.created_at
    };
  });

  res.json({ submissions });
});

module.exports = router;
