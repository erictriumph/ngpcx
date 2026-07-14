const db = require('../db');

function findExistingId(name, type = 'app') {
    if (!name) return null;

    const normalized = name.toLowerCase().replace(/[\s\-_.]/g, '');

    const existing = db.prepare(`
    SELECT id, name, confidence FROM apps 
    WHERE REPLACE(REPLACE(REPLACE(REPLACE(LOWER(name), ' ', ''), '-', ''), '_', ''), '.', '') = ?
    AND type = ?
    ORDER BY confidence DESC
    LIMIT 1
  `).get(normalized, type);

    return existing ? existing.id : null;
}

function mergeApp(entry) {
    const type = entry.type || 'app';
    const existingId = findExistingId(entry.name, type);
    const id = existingId || entry.id;

    try {
        // architectures is left NULL on insert — no source here actually determines a
        // per-app binary architecture, so writing a hardcoded 'arm64' guess was
        // misleading. Missing data is preferable to data that looks authoritative but
        // isn't. Nothing currently reads this column; it's reserved for real detection
        // if that's ever built.
        db.prepare(`
      INSERT INTO apps (id, name, publisher, type, arm_support, architectures, source, source_url, notes, confidence, last_updated)
      VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)
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
            type,
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