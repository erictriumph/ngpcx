const express = require('express');
const router = express.Router();
const passport = require('passport');
const crypto = require('crypto');
const db = require('../db');
const { ANON_COOKIE_NAME } = require('../identity');

const STATE_MAX_AGE_MS = 10 * 60 * 1000;

const PROVIDER_CONFIG = {
  google: { envPrefix: 'GOOGLE', scope: ['profile'] },
  github: { envPrefix: 'GITHUB', scope: ['read:user'] },
};

function isValidReturnSession(sessionId) {
  if (!sessionId) return null;
  const s = db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(sessionId);
  if (!s || new Date(s.expires_at) < new Date()) return null;
  return s;
}

// Reassigns each of the departing anonymous identity's submissions to the newly
// authenticated user, unless the user already has a submission for that app — in
// which case the authenticated row is canonical and untouched, and the anonymous row
// is marked superseded (never merged, never deleted — preserves attribution/history).
function migrateAnonymousSubmissions(anonymousId, userId) {
  const migrate = db.transaction((anonId, uid) => {
    const rows = db.prepare(`SELECT * FROM community_submissions WHERE anonymous_id = ?`).all(anonId);
    for (const row of rows) {
      const collision = db.prepare(`
        SELECT id FROM community_submissions WHERE user_id = ? AND normalized_name = ?
      `).get(uid, row.normalized_name);

      if (collision) {
        db.prepare(`UPDATE community_submissions SET state = 'superseded' WHERE id = ?`).run(row.id);
      } else {
        db.prepare(`UPDATE community_submissions SET user_id = ?, anonymous_id = NULL WHERE id = ?`).run(uid, row.id);
      }
    }
  });
  migrate(anonymousId, userId);
}

// GET /auth/google, /auth/github — begins the flow. The report session to return to
// (?return=<id>) is validated and stored server-side against a fresh random state
// token, never passed through as the OAuth state itself. A short-lived cookie binds
// that state to this browser — the state table alone only proves a flow was started by
// *someone*, not that *this* browser is the one presenting the callback (login CSRF).
function startOAuth(providerName) {
  const config = PROVIDER_CONFIG[providerName];
  return (req, res, next) => {
    if (!process.env[`${config.envPrefix}_CLIENT_ID`]) {
      return res.status(503).send(`Sign-in with ${providerName} is not configured.`);
    }

    const returnSessionId = isValidReturnSession(req.query.return) ? req.query.return : null;
    const state = crypto.randomUUID();

    db.prepare(`INSERT INTO oauth_states (state, return_session_id, created_at) VALUES (?, ?, datetime('now'))`)
      .run(state, returnSessionId);

    res.cookie('oauth_nonce', state, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/auth',
      maxAge: STATE_MAX_AGE_MS,
    });

    passport.authenticate(providerName, { state, scope: config.scope })(req, res, next);
  };
}

// GET /auth/google/callback, /auth/github/callback
function callbackHandlers(providerName) {
  return [
    (req, res, next) => {
      const state = req.query.state;
      const nonceCookie = req.cookies && req.cookies.oauth_nonce;
      res.clearCookie('oauth_nonce', { path: '/auth' });

      if (!state || !nonceCookie || state !== nonceCookie) {
        return res.status(403).send('Invalid or expired sign-in attempt — please try again.');
      }
      next();
    },
    passport.authenticate(providerName, { session: true, failureRedirect: '/' }),
    (req, res) => {
      const state = req.query.state;
      const stateRow = db.prepare(`SELECT * FROM oauth_states WHERE state = ?`).get(state);
      db.prepare(`DELETE FROM oauth_states WHERE state = ?`).run(state);

      const anonymousId = req.cookies && req.cookies[ANON_COOKIE_NAME];
      if (anonymousId && req.user) {
        migrateAnonymousSubmissions(anonymousId, req.user.id);
      }

      // Redirect target is never taken from client input — only ever reconstructed
      // from the session id the server itself stored and just re-validated.
      let redirectTo = '/';
      if (stateRow && stateRow.return_session_id && isValidReturnSession(stateRow.return_session_id)) {
        redirectTo = `/report.html?session=${encodeURIComponent(stateRow.return_session_id)}`;
      }
      res.redirect(redirectTo);
    },
  ];
}

router.get('/google', startOAuth('google'));
router.get('/github', startOAuth('github'));
router.get('/google/callback', ...callbackHandlers('google'));
router.get('/github/callback', ...callbackHandlers('github'));

router.get('/logout', (req, res, next) => {
  req.logout((err) => {
    if (err) return next(err);
    res.redirect('/');
  });
});

module.exports = router;
