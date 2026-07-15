const express = require('express');
const router = express.Router();
const db = require('../db');
const { lookupGithubForApp } = require('../scrapers/github-lookup');

const LOOKUP_COOLDOWN_DAYS = 14;

const SYSTEM_COMPONENT_PATTERNS = [
  'redistributable',
  'runtime',
  'sdk',
  'desktop runtime',
  'shared framework',
  'class driver',
  'windows software development kit',
  'update health tools',
  'corefonts',
  'coreeditorfonts',
];

function isSystemComponent(name, publisher) {
  if (!name) return false;
  const isMicrosoft = (publisher || '').toLowerCase().includes('microsoft');
  if (!isMicrosoft) return false;

  const nameLower = name.toLowerCase();
  return SYSTEM_COMPONENT_PATTERNS.some((p) => nameLower.includes(p));
}

// Merges a matched DB catalog row with the scanner's raw observation for this
// scan. `app` is spread over `entry` so scanner-observed fields (version,
// recently_used, discovery_source, etc.) always reflect this scan — except
// publisher, which the DB entry wins when present: the scanner's `publisher`
// is often just a coarse hint derived from a winget package ID's vendor
// segment (used to unblock isSystemComponent()'s Microsoft-gate below), and
// should never overwrite a real catalog publisher for an app the DB already
// has better data on.
function mergeEntryWithApp(entry, app) {
  return { ...entry, ...app, publisher: entry.publisher || app.publisher };
}

function trackUnknownApp(name) {
  if (!name) return;
  try {
    db.prepare(`
      INSERT INTO unknown_apps (name, count, last_seen)
      VALUES (?, 1, datetime('now'))
      ON CONFLICT(name) DO UPDATE SET
        count = count + 1,
        last_seen = excluded.last_seen
    `).run(name);
  } catch (err) {
    console.error('  Failed to track unknown app:', name, '-', err.message);
  }
}

// Classifies a raw apps array against current DB state. Pulled out of the
// /scan handler so the refresh endpoint can re-run the identical logic
// later, once background lookups or admin edits have changed the DB —
// without needing a whole new physical scan.
function classifyApps(apps) {
  const native = [];
  const emulated = [];
  const unsupported = [];
  const unknown = [];
  const systemComponents = [];

  for (const app of apps) {
    // Look up this app in the database
    // Look up by Winget ID first (exact match, fastest)
    let entry = db.prepare(`
      SELECT * FROM apps WHERE LOWER(id) = LOWER(?)
    `).get(app.id || '');

    // Fall back to normalized name match
    if (!entry && app.name) {
      const normalized = app.name.toLowerCase().replace(/[\s\-_.]/g, '');
      entry = db.prepare(`
        SELECT * FROM apps
        WHERE REPLACE(REPLACE(REPLACE(REPLACE(LOWER(name), ' ', ''), '-', ''), '_', ''), '.', '') = ?
        ORDER BY confidence DESC
        LIMIT 1
      `).get(normalized);
    }

    // Final fallback - partial name match
    if (!entry && app.name) {
      const nameLower = app.name.toLowerCase();
      entry = db.prepare(`
        SELECT * FROM apps
        WHERE LOWER(name) LIKE ?
        ORDER BY confidence DESC
        LIMIT 1
      `).get(`%${nameLower}%`);
    }

    // Admin-confirmed system components override the heuristic
    if (entry && entry.type === 'system') {
      systemComponents.push(mergeEntryWithApp(entry, app));
      continue;
    }

    if (!entry) {
      if (isSystemComponent(app.name, app.publisher)) {
        systemComponents.push(app);
        continue;
      }
      trackUnknownApp(app.name);
      unknown.push({ ...app, arm_support: 'unknown' });
      continue;
    }

    db.prepare(`UPDATE apps SET times_matched = times_matched + 1 WHERE id = ?`).run(entry.id);

    switch (entry.arm_support) {
      case 'native':
        native.push(mergeEntryWithApp(entry, app));
        break;
      case 'x64-emulated':
      case 'x86-emulated':
        emulated.push(mergeEntryWithApp(entry, app));
        break;
      case 'unsupported':
        unsupported.push(mergeEntryWithApp(entry, app));
        break;
      default:
        unknown.push(mergeEntryWithApp(entry, app));
    }
  }

  // Calculate readiness score. Unknown apps count as presumed-emulated
  // (same 60-point weight as confirmed Emulated) rather than being excluded —
  // Windows on ARM runs ordinary x86/x64 apps under emulation by default, so
  // true incompatibility is the rare case, not "no data either way." The
  // confidence indicator (report.html) deliberately stays scoped to
  // native+emulated+unsupported — it answers "how much do we actually know,"
  // a different question from the score's "how likely is this to work."
  const total = native.length + emulated.length + unsupported.length + unknown.length;
  const score = total === 0 ? 0 : Math.round(
    (native.length * 100 + (emulated.length + unknown.length) * 60 - unsupported.length * 20) /
    (total * 100) * 100
  );

  return { native, emulated, unsupported, unknown, systemComponents, score };
}

function shouldAttemptLookup(lastAttemptIso) {
  if (!lastAttemptIso) return true;
  const days = (Date.now() - new Date(lastAttemptIso).getTime()) / 86400000;
  return days > LOOKUP_COOLDOWN_DAYS;
}

// Fires on-demand GitHub lookups for apps this scan couldn't confidently
// classify, bounded by a cooldown so volume stays tied to real scan
// activity — never a bulk crawl. Never awaited by the caller; each lookup
// runs independently after the response has already been sent.
function triggerBackgroundLookups(classified) {
  for (const app of classified.unknown) {
    if (!app.name) continue;
    const row = db.prepare(`SELECT last_lookup_attempt FROM unknown_apps WHERE name = ?`).get(app.name);
    if (!row || !shouldAttemptLookup(row.last_lookup_attempt)) continue;

    db.prepare(`UPDATE unknown_apps SET last_lookup_attempt = datetime('now') WHERE name = ?`).run(app.name);
    lookupGithubForApp(app.name).catch((err) => {
      console.error('  Background lookup error for', app.name, '-', err.message);
    });
  }

  // Emulated/unsupported apps already have an apps-table row, so reuse its
  // last_updated as the cooldown gate instead of a separate column.
  for (const app of [...classified.emulated, ...classified.unsupported]) {
    if (!app.id || !app.name) continue;
    if (!shouldAttemptLookup(app.last_updated)) continue;

    db.prepare(`UPDATE apps SET last_updated = datetime('now') WHERE id = ?`).run(app.id);
    lookupGithubForApp(app.name).catch((err) => {
      console.error('  Background lookup error for', app.name, '-', err.message);
    });
  }
}

// POST /api/scan
// Receives a list of apps from the scanner, returns a readiness report
router.post('/scan', (req, res) => {
  const { apps, system, scan_mode } = req.body;

  if (!apps || !Array.isArray(apps)) {
    return res.status(400).json({ error: 'Invalid request - expected an apps array' });
  }

  const classified = classifyApps(apps);

  const report = {
    ...classified,
    scan_mode: scan_mode || 'unknown',
    system: system || null,
    devices: req.body.devices || [],
    // Passed through for future debugging/report logic — not interpreted or
    // acted on anywhere today. Absent/null for scanner builds older than this
    // change, which is expected and harmless.
    scanner_version: req.body.scanner_version || null,
    payload_version: req.body.payload_version || null,
    lastScanned: new Date().toISOString()
  };

  // If a session ID was provided, store results (only if not expired)
  const sessionId = req.body.session_id;
  if (sessionId) {
    const session = db.prepare(`SELECT expires_at FROM sessions WHERE id = ?`).get(sessionId);
    if (session && new Date(session.expires_at) >= new Date()) {
      db.prepare(`
        UPDATE sessions SET status = 'complete', results = ?, raw_apps = ?
        WHERE id = ?
      `).run(JSON.stringify(report), JSON.stringify(apps), sessionId);
    } else if (session) {
      console.log(`  Ignored scan submission for expired session: ${sessionId}`);
    }
  }

  res.json(report);

  triggerBackgroundLookups(classified);
});

module.exports = router;
module.exports.classifyApps = classifyApps;