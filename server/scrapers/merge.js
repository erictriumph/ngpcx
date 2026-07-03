const db = require('../db');

/**
 * Find existing app entry by name, regardless of source
 * Returns the existing ID if found, null if not
 */
function findExistingId(name) {
  if (!name) return null;
  
  const normalized = name.toLowerCase().replace(/[\s\-_.]/g, '');
  
  const existing = db.prepare(`
    SELECT id, name, confidence FROM apps 
    WHERE REPLACE(REPLACE(REPLACE(REPLACE(LOWER(name), ' ', ''), '-', ''), '_', ''), '.', '') = ?
    ORDER BY confidence DESC
    LIMIT 1
  `).get(normalized);

  return existing ? existing.id : null;
}

/**
 * Upsert an app entry, merging with existing data if found
 * Higher confidence always wins on conflicting fields
 */
function mergeApp(entry) {
  const existingId = findExistingId(entry.name);
  const id = existingId || entry.id;

  try {
    db.prepare(`
      INSERT INTO apps (id, name, publisher, arm_support, architectures, source, source_url, notes, confidence, last_updated)
      VALUES (?, ?, ?, ?, 'arm64', ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        arm_support = CASE 
          WHEN excluded.arm_support != 'unknown' AND excluded.confidence >= confidence 
          THEN excluded.arm_support 
          ELSE arm_support 
        END,
        confidence = CASE
          WHEN excluded.arm_support = arm_support AND excluded.arm_support != 'unknown'
          THEN MIN(confidence + 0.05, 1.0)
          WHEN excluded.confidence >= confidence
          THEN excluded.confidence
          ELSE confidence
        END,
        publisher = COALESCE(publisher, excluded.publisher),
        notes = COALESCE(excluded.notes, notes),
        source_url = COALESCE(source_url, excluded.source_url),
        last_updated = excluded.last_updated
    `).run(
      id,
      entry.name,
      entry.publisher || null,
      entry.arm_support,
      entry.source,
      entry.source_url || null,
      entry.notes || null,
      entry.confidence,
      new Date().toISOString()
    );

    return id;
  } catch (err) {
    console.error('  Merge failed for:', entry.name, '-', err.message);
    return null;
  }
}

module.exports = { findExistingId, mergeApp };