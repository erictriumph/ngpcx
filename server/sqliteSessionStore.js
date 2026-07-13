const session = require('express-session');

const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

// express-session Store backed directly by the existing better-sqlite3 db instance and
// the auth_sessions table (see db.js) — avoids a second native SQLite driver
// (connect-sqlite3) or an immature single-maintainer package
// (better-sqlite3-session-store, last published 2022). better-sqlite3 is synchronous,
// so every method here resolves its callback immediately.
class SqliteSessionStore extends session.Store {
  constructor({ db }) {
    super();
    this.db = db;
  }

  get(sid, callback) {
    try {
      const row = this.db.prepare(
        `SELECT session_json FROM auth_sessions WHERE sid = ? AND expires_at > datetime('now')`
      ).get(sid);
      callback(null, row ? JSON.parse(row.session_json) : null);
    } catch (err) {
      callback(err);
    }
  }

  set(sid, sessionData, callback) {
    try {
      const expiresAtMs = sessionData.cookie && sessionData.cookie.expires
        ? new Date(sessionData.cookie.expires).getTime()
        : Date.now() + DEFAULT_MAX_AGE_MS;
      const expiresAt = new Date(expiresAtMs).toISOString();

      this.db.prepare(`
        INSERT INTO auth_sessions (sid, session_json, expires_at) VALUES (?, ?, ?)
        ON CONFLICT(sid) DO UPDATE SET session_json = excluded.session_json, expires_at = excluded.expires_at
      `).run(sid, JSON.stringify(sessionData), expiresAt);
      callback(null);
    } catch (err) {
      callback(err);
    }
  }

  destroy(sid, callback) {
    try {
      this.db.prepare(`DELETE FROM auth_sessions WHERE sid = ?`).run(sid);
      callback(null);
    } catch (err) {
      callback(err);
    }
  }

  touch(sid, sessionData, callback) {
    try {
      const expiresAtMs = sessionData.cookie && sessionData.cookie.expires
        ? new Date(sessionData.cookie.expires).getTime()
        : Date.now() + DEFAULT_MAX_AGE_MS;
      const expiresAt = new Date(expiresAtMs).toISOString();

      this.db.prepare(`UPDATE auth_sessions SET expires_at = ? WHERE sid = ?`).run(expiresAt, sid);
      callback(null);
    } catch (err) {
      callback(err);
    }
  }
}

module.exports = SqliteSessionStore;
