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
    arm_support TEXT NOT NULL DEFAULT 'unknown',
    architectures TEXT,
    source TEXT,
    notes TEXT,
    confidence REAL DEFAULT 0.5,
    last_updated TEXT
  )
`);

console.log('Database ready at', DB_PATH);

module.exports = db;