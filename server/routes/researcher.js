const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAuthenticatedUser } = require('../middleware/auth');

// Eligibility is intentionally a single, simple threshold — not a scoring system.
// Meeting it only reveals the invitation; it never grants or implies approval.
const ELIGIBILITY_THRESHOLD = 3;

// A declined request isn't a permanent block — after this cooldown, the invitation
// (if the user is still eligible) simply reappears in place of the declined message,
// so re-requesting needs no separate "try again" UI, just normal continued use.
const DECLINE_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;

router.use(requireAuthenticatedUser);

function activeSubmissionCount(userId) {
  return db.prepare(`
    SELECT COUNT(*) AS c FROM community_submissions WHERE user_id = ? AND state = 'active'
  `).get(userId).c;
}

function latestRequest(userId) {
  return db.prepare(`
    SELECT * FROM researcher_requests WHERE user_id = ? ORDER BY id DESC LIMIT 1
  `).get(userId);
}

// GET /api/researcher/status — the single source of truth for which state
// My Submissions should render: 'welcome' | 'pending' | 'declined' | 'invite' | 'none'.
// Computed server-side so the client never has to re-derive eligibility/cooldown logic.
router.get('/status', (req, res) => {
  const user = req.user;

  if (user.role === 'researcher' || user.role === 'admin') {
    const uiState = (user.role === 'researcher' && !user.researcher_welcome_seen) ? 'welcome' : 'none';
    return res.json({ role: user.role, uiState });
  }

  const request = latestRequest(user.id);

  if (request && request.status === 'pending') {
    return res.json({ role: user.role, uiState: 'pending' });
  }

  if (request && request.status === 'declined') {
    const declinedAt = new Date(request.reviewed_at).getTime();
    if (Date.now() - declinedAt < DECLINE_COOLDOWN_MS) {
      return res.json({ role: user.role, uiState: 'declined' });
    }
  }

  const count = activeSubmissionCount(user.id);
  const uiState = count >= ELIGIBILITY_THRESHOLD ? 'invite' : 'none';
  res.json({ role: user.role, uiState });
});

// POST /api/researcher/volunteer — { note? }
// Idempotent by design: a repeat click while already pending returns the same
// success shape rather than erroring, and the partial unique index in db.js makes
// this true even under a race, not just in this single-threaded check-then-insert.
router.post('/volunteer', (req, res) => {
  const user = req.user;
  if (user.role !== 'user') {
    return res.status(409).json({ error: 'Only regular users can volunteer as a Researcher.' });
  }

  const existing = latestRequest(user.id);
  if (existing && existing.status === 'pending') {
    return res.json({ success: true, status: 'pending', alreadyPending: true });
  }

  const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 500) : null;

  db.prepare(`
    INSERT INTO researcher_requests (user_id, status, note, requested_at)
    VALUES (?, 'pending', ?, datetime('now'))
  `).run(user.id, note || null);

  res.json({ success: true, status: 'pending', alreadyPending: false });
});

// POST /api/researcher/withdraw — no-op (success) if nothing is pending, so this is
// safe to call without the caller needing to know the current state first.
router.post('/withdraw', (req, res) => {
  const existing = latestRequest(req.user.id);
  if (!existing || existing.status !== 'pending') {
    return res.json({ success: true, withdrawn: false });
  }

  db.prepare(`UPDATE researcher_requests SET status = 'withdrawn', reviewed_at = datetime('now') WHERE id = ?`)
    .run(existing.id);

  res.json({ success: true, withdrawn: true });
});

// POST /api/researcher/welcome-ack — dismisses the one-time welcome message.
// Sticky on the account, not session-based, so it stays dismissed across visits.
router.post('/welcome-ack', (req, res) => {
  db.prepare(`UPDATE users SET researcher_welcome_seen = 1 WHERE id = ?`).run(req.user.id);
  res.json({ success: true });
});

module.exports = router;
