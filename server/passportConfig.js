const db = require('./db');

// New accounts always default to role='user' here — role elevation is never automatic
// anywhere in this codebase, only via the manual bootstrap procedure (see CLAUDE.md).
function findOrCreateUser(provider, providerId, displayName) {
  const existing = db.prepare(`SELECT * FROM users WHERE provider = ? AND provider_id = ?`).get(provider, providerId);
  if (existing) return existing;

  const info = db.prepare(`
    INSERT INTO users (provider, provider_id, display_name, role, disabled, created_at)
    VALUES (?, ?, ?, 'user', 0, datetime('now'))
  `).run(provider, providerId, displayName || null);

  return db.prepare(`SELECT * FROM users WHERE id = ?`).get(info.lastInsertRowid);
}

function configurePassport(passport) {
  // Only user.id is ever stored in the session — deserializeUser re-reads the full row
  // from the database on every request, so role/disabled changes take effect
  // immediately without requiring logout (see server/middleware/auth.js).
  passport.serializeUser((user, done) => done(null, user.id));
  passport.deserializeUser((id, done) => {
    try {
      const user = db.prepare(`SELECT * FROM users WHERE id = ?`).get(id);
      done(null, user || false);
    } catch (err) {
      done(err);
    }
  });

  const baseUrl = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;

  // Strategies are only registered if their credentials are present, so one provider
  // missing its env vars doesn't break the other while OAUTH_ENABLED=true.
  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
    const GoogleStrategy = require('passport-google-oauth20').Strategy;
    passport.use(new GoogleStrategy({
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: `${baseUrl}/auth/google/callback`,
    }, (accessToken, refreshToken, profile, done) => {
      try {
        done(null, findOrCreateUser('google', profile.id, profile.displayName));
      } catch (err) {
        done(err);
      }
    }));
  }

  if (process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET) {
    const GitHubStrategy = require('passport-github2').Strategy;
    passport.use(new GitHubStrategy({
      clientID: process.env.GITHUB_CLIENT_ID,
      clientSecret: process.env.GITHUB_CLIENT_SECRET,
      callbackURL: `${baseUrl}/auth/github/callback`,
    }, (accessToken, refreshToken, profile, done) => {
      try {
        done(null, findOrCreateUser('github', profile.id, profile.displayName || profile.username));
      } catch (err) {
        done(err);
      }
    }));
  }
}

module.exports = { configurePassport, findOrCreateUser };
