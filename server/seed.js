const db = require('./db');
const fs = require('fs');
const path = require('path');

const CACHE_DIR = path.join(__dirname, '../.cache/winget');

function seedFromCache() {
  // Check if database already has data
  const count = db.prepare('SELECT COUNT(*) as count FROM apps').get();
  if (count.count > 0) {
    console.log(`Database already has ${count.count} entries — skipping seed.`);
    return;
  }

  console.log('Database is empty — seeding from cache...');

  if (!fs.existsSync(CACHE_DIR)) {
    console.log('No cache found — skipping seed. Run the scraper first.');
    return;
  }

  // Read all cached YAML results (the parsed package files, not search results)
  const files = fs.readdirSync(CACHE_DIR)
    .filter(f => f.endsWith('.json') && !f.startsWith('search_') && !f.startsWith('vendors_'));

  console.log(`Found ${files.length} cached package files...`);

  let seeded = 0;
  let skipped = 0;

  for (const file of files) {
    try {
      const data = JSON.parse(
        fs.readFileSync(path.join(CACHE_DIR, file), 'utf8')
      );

      // Skip search/vendor cache files that slipped through
      if (!data.id || !data.name || !data.arm_support === undefined) {
        skipped++;
        continue;
      }

      // Only seed native ARM64 entries
      db.prepare(`
        INSERT INTO apps (id, name, publisher, arm_support, architectures, source, source_url, notes, confidence, last_updated)
        VALUES (?, ?, ?, 'native', 'arm64', 'winget', ?, 'ARM64 installer available in winget', 0.95, ?)
        ON CONFLICT(id) DO NOTHING
      `).run(
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

  console.log(`✓ Seeded ${seeded} apps from cache (${skipped} skipped).`);
}

module.exports = { seedFromCache };