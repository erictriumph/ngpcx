const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// DATA_DIR is configurable specifically so a Railway Volume can be mounted at any path
// (e.g. /data) without relying on Railway's internal build-output directory (/app) —
// defaults to the existing repo-relative location, so local dev and any environment
// without DATA_DIR set behave exactly as before. See CLAUDE.md, Railway Volume section.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'compatibility.db');

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);

// Create the apps table if it doesn't exist
db.exec(`
  CREATE TABLE IF NOT EXISTS apps (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    publisher TEXT,
    type TEXT NOT NULL DEFAULT 'app',
    arm_support TEXT NOT NULL DEFAULT 'unknown',
    architectures TEXT,
    source TEXT,
    notes TEXT,
    confidence REAL DEFAULT 0.5,
    last_updated TEXT
  );

  -- Add type column if upgrading from old schema
  CREATE TABLE IF NOT EXISTS schema_version (version INTEGER);
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'waiting',
    results TEXT,
    created_at TEXT,
    expires_at TEXT
  );
  CREATE TABLE IF NOT EXISTS unknown_apps (
    name TEXT PRIMARY KEY,
    count INTEGER NOT NULL DEFAULT 1,
    last_seen TEXT NOT NULL
  );
  -- anonymous_id/user_id: exactly one populated per row going forward (enforced by
  -- /submit, never both — see the CHECK below). Pre-migration rows may have neither;
  -- those are excluded from consensus calculations (see scan.js/community.js/admin.js).
  CREATE TABLE IF NOT EXISTS community_submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    app_name TEXT NOT NULL,
    normalized_name TEXT NOT NULL,
    session_id TEXT NOT NULL,
    anonymous_id TEXT,
    user_id INTEGER,
    arm_support TEXT NOT NULL,
    notes TEXT,
    state TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL,
    CHECK (anonymous_id IS NULL OR user_id IS NULL)
  );
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    display_name TEXT,
    role TEXT NOT NULL DEFAULT 'user',
    disabled INTEGER NOT NULL DEFAULT 0,
    contact_opt_in INTEGER NOT NULL DEFAULT 0,
    contact_email TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(provider, provider_id)
  );
  CREATE TABLE IF NOT EXISTS auth_sessions (
    sid TEXT PRIMARY KEY,
    session_json TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS oauth_states (
    state TEXT PRIMARY KEY,
    return_session_id TEXT,
    created_at TEXT NOT NULL
  );
  -- Generic key/value marker table. Currently used for one thing: seed.js writes
  -- 'seeded_at' as the final statement of its seed transaction, so its presence proves
  -- the cache seed provably ran to completion (see seed.js) — a row count alone can't
  -- distinguish "fully seeded" from "died halfway through."
  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT
  )
`);

// Clean up expired Passport sessions and stale (never-completed) OAuth handshakes
db.prepare(`DELETE FROM auth_sessions WHERE expires_at < datetime('now')`).run();
db.prepare(`DELETE FROM oauth_states WHERE created_at < datetime('now', '-10 minutes')`).run();

// Rebuild community_submissions if it predates anonymous_id/user_id/state (drops the
// old UNIQUE(app_name, session_id) constraint, which SQLite can't ALTER away in place,
// and adds the CHECK(anonymous_id IS NULL OR user_id IS NULL) constraint). Pre-existing
// rows carry forward with anonymous_id/user_id left NULL — nobody had an identity yet.
{
  const schemaVersion = db.prepare(`SELECT MAX(version) AS v FROM schema_version`).get().v || 0;
  if (schemaVersion < 2) {
    const columns = db.prepare(`PRAGMA table_info(community_submissions)`).all();
    const hasAnonymousId = columns.some((c) => c.name === 'anonymous_id');
    if (!hasAnonymousId) {
      db.exec(`
        CREATE TABLE community_submissions_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          app_name TEXT NOT NULL,
          normalized_name TEXT NOT NULL,
          session_id TEXT NOT NULL,
          anonymous_id TEXT,
          user_id INTEGER,
          arm_support TEXT NOT NULL,
          notes TEXT,
          state TEXT NOT NULL DEFAULT 'active',
          created_at TEXT NOT NULL,
          CHECK (anonymous_id IS NULL OR user_id IS NULL)
        );
        INSERT INTO community_submissions_new (id, app_name, normalized_name, session_id, arm_support, notes, created_at)
          SELECT id, app_name, normalized_name, session_id, arm_support, notes, created_at FROM community_submissions;
        DROP TABLE community_submissions;
        ALTER TABLE community_submissions_new RENAME TO community_submissions;
      `);
    }
    db.prepare(`INSERT INTO schema_version (version) VALUES (2)`).run();
  }
}

// Partial unique indexes: uniqueness enforced separately within each identity type,
// never across them (a row's anonymous_id/user_id are never both populated, so these
// never conflict with each other for the same row).
db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_community_anon_app
    ON community_submissions(anonymous_id, normalized_name) WHERE anonymous_id IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_community_user_app
    ON community_submissions(user_id, normalized_name) WHERE user_id IS NOT NULL;
`);

// Clean up sessions older than 24 hours
db.prepare(`
  DELETE FROM sessions WHERE created_at < datetime('now', '-24 hours')
`).run();

// Add type column if it doesn't exist (for existing databases)
try {
  db.exec(`ALTER TABLE apps ADD COLUMN type TEXT NOT NULL DEFAULT 'app'`);
} catch {
  // Column already exists, ignore
}

try {
  db.exec(`ALTER TABLE apps ADD COLUMN min_arm_version TEXT`);
} catch {
  // Column already exists, ignore
}

try {
  db.exec(`ALTER TABLE apps ADD COLUMN source_url TEXT`);
} catch {
  // Column already exists, ignore
}

try {
  db.exec(`ALTER TABLE apps ADD COLUMN times_matched INTEGER NOT NULL DEFAULT 0`);
} catch {
  // Column already exists, ignore
}

try {
  db.exec(`ALTER TABLE sessions ADD COLUMN raw_apps TEXT`);
} catch {
  // Column already exists, ignore
}

try {
  db.exec(`ALTER TABLE unknown_apps ADD COLUMN last_lookup_attempt TEXT`);
} catch {
  // Column already exists, ignore
}

console.log('Database ready at', DB_PATH);

module.exports = db;