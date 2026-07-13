const db = require('./db');
const fs = require('fs');
const path = require('path');
const { mergeApp } = require('./scrapers/merge');
const { saveToDb: saveWingetEntry } = require('./scrapers/winget');
const { buildAppEntry: buildWoaEntry } = require('./scrapers/community/worksonwoa');

const WINGET_CACHE_DIR = path.join(__dirname, '../.cache/winget');
const WOA_CACHE_FILE = path.join(__dirname, '../.cache/worksonwoa/projects.json');

// Every bulk cache source the seed is expected to cover. Recorded (not just a bare
// timestamp) in meta.seed_sources so an older marker written before a source was added
// here — e.g. the winget-only marker from before this file covered WorksOnWoA too —
// correctly reads as incomplete and triggers a safe re-run, rather than silently
// leaving a whole source unseeded forever.
const EXPECTED_SOURCES = ['winget', 'worksonwoa'];
const SOURCES_MARKER_KEY = 'seed_sources';
const SEEDED_AT_MARKER_KEY = 'seeded_at';

function completedSourceSet() {
  const row = db.prepare(`SELECT value FROM meta WHERE key = ?`).get(SOURCES_MARKER_KEY);
  return row ? new Set(row.value.split(',').filter(Boolean)) : new Set();
}

function hasCompletedSeed() {
  const completed = completedSourceSet();
  return EXPECTED_SOURCES.every((s) => completed.has(s));
}

// Reads every non-search/vendor winget cache file and merges it via the exact same
// saveToDb() the live winget.js scraper uses — no separate interpretation of the data.
function seedWinget() {
  const result = { processed: 0, merged: 0, skipped: 0, available: fs.existsSync(WINGET_CACHE_DIR) };
  if (!result.available) return result;

  const files = fs.readdirSync(WINGET_CACHE_DIR)
    .filter((f) => f.endsWith('.json') && !f.startsWith('search_') && !f.startsWith('vendors_'));

  for (const file of files) {
    result.processed++;
    try {
      const data = JSON.parse(fs.readFileSync(path.join(WINGET_CACHE_DIR, file), 'utf8'));
      if (!data.id || !data.name) {
        result.skipped++;
        continue;
      }
      saveWingetEntry(data);
      result.merged++;
    } catch {
      result.skipped++;
    }
  }

  return result;
}

// Reads the committed WorksOnWoA cache and merges it via the exact same buildAppEntry()
// the live worksonwoa.js scraper uses — same skip rules (games, unknown compatibility),
// same confidence/arm_support mapping, same id/source_url construction.
function seedWorksOnWoA() {
  const result = { processed: 0, merged: 0, skipped: 0, available: fs.existsSync(WOA_CACHE_FILE) };
  if (!result.available) return result;

  let apps;
  try {
    const data = JSON.parse(fs.readFileSync(WOA_CACHE_FILE, 'utf8'));
    apps = Array.isArray(data) ? data : [];
  } catch {
    result.available = false;
    return result;
  }

  result.processed = apps.length;
  for (const app of apps) {
    const entry = buildWoaEntry(app);
    if (!entry) {
      result.skipped++;
      continue;
    }
    mergeApp(entry);
    result.merged++;
  }

  return result;
}

function seedFromCache() {
  if (hasCompletedSeed()) {
    const count = db.prepare('SELECT COUNT(*) as count FROM apps').get();
    console.log(`Database already has a completed seed (${count.count} entries, sources: ${[...completedSourceSet()].join(', ')}) — skipping seed.`);
    return;
  }

  const existingCount = db.prepare('SELECT COUNT(*) as count FROM apps').get().count;
  const completed = completedSourceSet();
  const missing = EXPECTED_SOURCES.filter((s) => !completed.has(s));
  if (existingCount > 0) {
    console.log(`Found ${existingCount} app rows but seed sources [${[...completed].join(', ') || 'none'}] don't cover expected [${EXPECTED_SOURCES.join(', ')}] — missing: ${missing.join(', ')}. Re-running seed (safe: mergeApp() is idempotent, already-present rows are just updated/skipped, never duplicated).`);
  } else {
    console.log('Database is empty — seeding from cache...');
  }

  let wingetResult;
  let woaResult;

  // One atomic transaction for the whole operation: if the process dies partway
  // through (crash, kill, hang), better-sqlite3/SQLite rolls back everything on the
  // next open — both sources' work together, not just whichever was running — so a
  // future boot correctly sees no completion marker and retries the whole thing,
  // instead of getting stuck on a permanent partial state.
  //
  // The seed_sources/seeded_at markers are only written if EVERY expected source's
  // cache was actually found this run — not partial credit for whichever sources
  // happened to be available. Data that DID get merged (e.g. winget succeeding while
  // worksonwoa's cache is unexpectedly missing) still stays committed; only the
  // "fully done" marker is withheld, so the next boot retries the whole seed rather
  // than silently treating a partially-covered database as complete.
  const seedAll = db.transaction(() => {
    wingetResult = seedWinget();
    woaResult = seedWorksOnWoA();

    if (wingetResult.available && woaResult.available) {
      db.prepare(`
        INSERT INTO meta (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(SOURCES_MARKER_KEY, EXPECTED_SOURCES.join(','));
      db.prepare(`
        INSERT INTO meta (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(SEEDED_AT_MARKER_KEY, new Date().toISOString());
    }
  });

  seedAll();

  if (!wingetResult.available) console.log('  Winget cache not found — skipped.');
  console.log(`  Winget: ${wingetResult.processed} processed, ${wingetResult.merged} merged, ${wingetResult.skipped} skipped.`);
  if (!woaResult.available) console.log('  WorksOnWoA cache not found — skipped.');
  console.log(`  WorksOnWoA: ${woaResult.processed} processed, ${woaResult.merged} merged, ${woaResult.skipped} skipped.`);

  const finalCount = db.prepare('SELECT COUNT(*) as count FROM apps').get().count;
  if (!wingetResult.available || !woaResult.available) {
    console.log(`✗ Seed incomplete — ${finalCount} total apps so far, no completion marker written. Will retry the full seed on next boot.`);
  } else {
    console.log(`✓ Seed complete — ${finalCount} total apps in database — seed marked complete.`);
  }
}

module.exports = { seedFromCache };
