const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'compatibility.db');

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
  CREATE TABLE IF NOT EXISTS community_submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    app_name TEXT NOT NULL,
    normalized_name TEXT NOT NULL,
    session_id TEXT NOT NULL,
    user_id TEXT,
    arm_support TEXT NOT NULL,
    notes TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(app_name, session_id)
  )
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