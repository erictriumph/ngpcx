const crypto = require('crypto');

const ANON_COOKIE_NAME = 'ngpcx_anon_id';
// Chrome (and the current cookie spec) hard-caps Max-Age at 400 days regardless of what's
// requested — this is the actual ceiling for "long but finite," not an arbitrary round number.
const ANON_COOKIE_MAX_AGE_MS = 400 * 24 * 60 * 60 * 1000;

// Reads the anonymous identity cookie, provisioning one on this response if absent.
// Contains only an opaque UUID — no personal data.
function ensureAnonymousId(req, res) {
  const existing = req.cookies && req.cookies[ANON_COOKIE_NAME];
  if (existing) return existing;

  const id = crypto.randomUUID();
  res.cookie(ANON_COOKIE_NAME, id, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: ANON_COOKIE_MAX_AGE_MS,
  });
  return id;
}

module.exports = { ANON_COOKIE_NAME, ensureAnonymousId };
