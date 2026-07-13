const db = require('./db');
const fs = require('fs');
const path = require('path');

const CACHE_DIR = path.join(__dirname, '../.cache/winget');
const SEEDED_MARKER_KEY = 'seeded_at';

// Whether seeding has ever provably completed — not "does the apps table have any
// rows," which can't distinguish a fully-seeded DB from one that died partway through
// a previous seed attempt (e.g. the process was killed mid-run) and got left with a
// nonzero-but-incomplete row count. The marker is only ever written as the last
// statement of the same transaction as the inserts (see below), so its presence is
// proof the whole seed committed, not just started.
function hasCompletedSeed() {
  return !!db.prepare(`SELECT 1 FROM meta WHERE key = ?`).get(SEEDED_MARKER_KEY);
}

function seedFromCache() {
  if (hasCompletedSeed()) {
    const count = db.prepare('SELECT COUNT(*) as count FROM apps').get();
    console.log(`Database already has a completed seed (${count.count} entries) — skipping seed.`);
    return;
  }

  const existingCount = db.prepare('SELECT COUNT(*) as count FROM apps').get().count;
  if (existingCount > 0) {
    console.log(`Found ${existingCount} app rows but no completed-seed marker — this looks like a partial seed from an interrupted previous run. Re-running seed (safe: inserts are ON CONFLICT DO NOTHING, so already-present rows are just skipped).`);
  } else {
    console.log('Database is empty — seeding from cache...');
  }

  if (!fs.existsSync(CACHE_DIR)) {
    console.log('No cache found — skipping seed. Run the scraper first.');
    return;
  }

  // Read all cached YAML results (the parsed package files, not search results)
  const files = fs.readdirSync(CACHE_DIR)
    .filter(f => f.endsWith('.json') && !f.startsWith('search_') && !f.startsWith('vendors_'));

  console.log(`Found ${files.length} cached package files...`);

  const insertApp = db.prepare(`
    INSERT INTO apps (id, name, publisher, arm_support, architectures, source, source_url, notes, confidence, last_updated)
    VALUES (?, ?, ?, 'native', 'arm64', 'winget', ?, 'ARM64 installer available in winget', 0.95, ?)
    ON CONFLICT(id) DO NOTHING
  `);
  const markSeeded = db.prepare(`
    INSERT INTO meta (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);

  let seeded = 0;
  let skipped = 0;

  // One atomic transaction for the whole operation: if the process dies partway
  // through (crash, kill, hang), better-sqlite3/SQLite rolls back everything on the
  // next open — including the marker below — so a future boot correctly sees "not
  // seeded" and retries, instead of getting stuck on a permanent partial state.
  const seedAll = db.transaction((fileList) => {
    for (const file of fileList) {
      try {
        const data = JSON.parse(
          fs.readFileSync(path.join(CACHE_DIR, file), 'utf8')
        );

        // Skip search/vendor cache files that slipped through
        if (!data.id || !data.name || !data.arm_support === undefined) {
          skipped++;
          continue;
        }

        insertApp.run(
          data.id,
          data.name,
          data.publisher || null,
          data.source_url || null,
          new Date().toISOString()
        );
        seeded++;

      } catch {
        skipped++;
      }
    }

    markSeeded.run(SEEDED_MARKER_KEY, new Date().toISOString());
  });

  seedAll(files);

  console.log(`✓ Seeded ${seeded} apps from cache (${skipped} skipped) — seed marked complete.`);
}

module.exports = { seedFromCache };