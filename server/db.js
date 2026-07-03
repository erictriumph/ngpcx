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

console.log('Database ready at', DB_PATH);

module.exports = db;