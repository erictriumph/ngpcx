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
  );
  -- A Researcher request is workflow, not authorization — it never IS the user's role,
  -- it only ever causes a role change when an admin approves it (see routes/admin.js).
  -- status: 'pending' | 'approved' | 'declined' | 'withdrawn'. decision_note is
  -- admin-internal only, never returned to the requesting user (see routes/researcher.js).
  CREATE TABLE IF NOT EXISTS researcher_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    note TEXT,
    requested_at TEXT NOT NULL,
    reviewed_at TEXT,
    reviewed_by INTEGER,
    decision_note TEXT
  );

  -- A Researcher Recommendation is additive evaluation of community evidence — it never
  -- overwrites a community_submissions row and never touches the apps catalog by itself.
  -- Only a second trusted person's Confirm/Revise action (see admin.js Community Review
  -- section) applies it to the catalog, via the same resolveAppCatalog() path direct
  -- admin/researcher resolutions already use. status: 'pending' | 'confirmed' | 'rejected'.
  -- created_by/reviewed_by are nullable (and paired with a *_label) for the same reason
  -- reviewed_by is nullable on researcher_requests: the legacy shared-secret auth path
  -- never populates req.user, so there's no user id to attribute the action to.
  -- evidence_snapshot: a small JSON fingerprint of community evidence at proposal time
  -- (distinct verdicts present, catalog/community agreement, a hash of note content, and
  -- a submission count) — NOT a copy of the evidence itself. Recomputed and compared
  -- live at Confirm/Revise time to detect whether material evidence has changed since
  -- proposal (see computeEvidenceFingerprint()/compareEvidenceFingerprints() in admin.js).
  -- Deliberately excludes contributor identity and note text — a hash can't be reversed
  -- back into the original notes.
  CREATE TABLE IF NOT EXISTS researcher_recommendations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    app_name TEXT NOT NULL,
    normalized_name TEXT NOT NULL,
    proposed_arm_support TEXT NOT NULL,
    proposed_notes TEXT,
    rationale TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_by INTEGER,
    created_by_label TEXT,
    created_at TEXT NOT NULL,
    reviewed_by INTEGER,
    reviewed_by_label TEXT,
    reviewed_at TEXT,
    review_note TEXT,
    evidence_snapshot TEXT
  );

  -- Append-only accountability trail for catalog-changing research actions (direct
  -- admin/researcher resolutions, confirmed/revised recommendations) plus the
  -- non-catalog-changing recommendation lifecycle events (proposed/rejected/left
  -- unresolved), so a future Research Activity page has real history to show. No UI
  -- reads this yet — Phase 1 of Community Review only captures it cleanly.
  CREATE TABLE IF NOT EXISTS research_activity_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    app_name TEXT NOT NULL,
    actor_id INTEGER,
    actor_label TEXT,
    action TEXT NOT NULL,
    previous_arm_support TEXT,
    new_arm_support TEXT,
    previous_notes TEXT,
    new_notes TEXT,
    created_at TEXT NOT NULL
  )
`);

// At most one pending request per user — makes repeated "volunteer" clicks harmless
// at the database level, not just in application logic (see routes/researcher.js).
db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_researcher_requests_pending_user
    ON researcher_requests(user_id) WHERE status = 'pending';
`);

// At most one pending recommendation per app — keeps the confirmation workflow
// lightweight (no need to reconcile multiple simultaneous proposals for the same app)
// and structurally prevents pile-up, mirroring the researcher_requests pattern above.
db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_recommendation_pending_app
    ON researcher_recommendations(normalized_name) WHERE status = 'pending';
`);

// Sticky per-account flag: the Researcher welcome message is shown at most once ever,
// regardless of later role changes — simpler than tying it to a specific request row,
// and avoids needing a general notification system for a single one-time message.
try {
  db.exec(`ALTER TABLE users ADD COLUMN researcher_welcome_seen INTEGER NOT NULL DEFAULT 0`);
} catch {
  // Column already exists, ignore
}

// Deletes expired scan sessions, expired Passport sessions, and stale
// (never-completed) OAuth handshakes. Run once at startup (below) and again
// periodically by server.js while the process stays up — startup alone leaves
// a gap between deploys where logically-expired rows sit on disk until the
// next restart. Kept here (not in server.js) so the SQL has exactly one
// definition, reused by both the one-off and recurring callers.
function cleanupExpiredRecords() {
  db.prepare(`DELETE FROM auth_sessions WHERE expires_at < datetime('now')`).run();
  db.prepare(`DELETE FROM oauth_states WHERE created_at < datetime('now', '-10 minutes')`).run();
  db.prepare(`DELETE FROM sessions WHERE created_at < datetime('now', '-24 hours')`).run();
}
cleanupExpiredRecords();

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

// researcher_recommendations predates evidence_snapshot (added for the stale-evidence
// confirmation guard, see admin.js) — this ALTER covers any DB where the table was
// created before that column existed; the CREATE TABLE above already includes it for
// a fresh DB, so this is a no-op there.
try {
  db.exec(`ALTER TABLE researcher_recommendations ADD COLUMN evidence_snapshot TEXT`);
} catch {
  // Column already exists, ignore
}

console.log('Database ready at', DB_PATH);

module.exports = db;
module.exports.cleanupExpiredRecords = cleanupExpiredRecords;