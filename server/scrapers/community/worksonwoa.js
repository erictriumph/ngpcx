require('dotenv').config();
const { mergeApp } = require('../merge');
const fs = require('fs');
const path = require('path');

const CACHE_DIR = path.join(__dirname, '../../../.cache/worksonwoa');
const CACHE_FILE = path.join(CACHE_DIR, 'projects.json');
const DATA_URL = 'https://raw.githubusercontent.com/Linaro/works-on-woa/staging/src/data/content/projects.json';

const HEADERS = {
  'User-Agent': 'ngpcx-scraper',
  'Accept': 'application/json'
};

// ─────────────────────────────────────────
//  ARM support level mapping
// ─────────────────────────────────────────

function mapCompatibility(app) {
  if (app.compatibility === 'no') return 'unsupported';
  if (app.compatibility === 'unknown') return 'unknown';
  if (app.compatibility === 'yes') {
    if (app.emulationType === 'native') return 'native';
    if (app.emulationType === 'emulation') return 'x64-emulated';
    return 'native'; // default yes to native
  }
  return 'unknown';
}

// ─────────────────────────────────────────
//  Confidence based on validation source
// ─────────────────────────────────────────

function getConfidence(app) {
  if (app.validation === 'qualcomm' || app.validation === 'microsoft') return 0.90;
  if (app.validation === 'community') return 0.75;
  return 0.80;
}

// ─────────────────────────────────────────
//  Cache helpers
// ─────────────────────────────────────────

function ensureCacheDir() {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
}

// ─────────────────────────────────────────
//  Main scraper
// ─────────────────────────────────────────

async function runWorksonwoaScraper() {
  console.log('Starting WorksOnWoA scraper...\n');
  ensureCacheDir();

  // Check cache first (max 24 hours old)
  let data = null;
  if (fs.existsSync(CACHE_FILE)) {
    const age = Date.now() - fs.statSync(CACHE_FILE).mtimeMs;
    if (age < 24 * 60 * 60 * 1000) {
      console.log('  Loading from cache...');
      data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    }
  }

  if (!data) {
    console.log('  Fetching projects.json from WorksOnWoA...');
    const res = await fetch(DATA_URL, { headers: HEADERS });
    if (!res.ok) {
      console.error(`  Failed to fetch: ${res.status}`);
      return;
    }
    data = await res.json();
    fs.writeFileSync(CACHE_FILE, JSON.stringify(data), 'utf8');
    console.log(`  Fetched and cached ${data.length} entries.`);
  }

  const apps = Array.isArray(data) ? data : [];
  console.log(`  Processing ${apps.length} entries...\n`);

  let saved = 0;
  let skipped = 0;

  for (const app of apps) {
    // Skip games — focus on apps
    if (app.type === 'game') {
      skipped++;
      continue;
    }

    const name = app.name;
    if (!name) { skipped++; continue; }

    // Skip unknown compatibility — not useful data
    const arm_support = mapCompatibility(app);
    if (arm_support === 'unknown') { skipped++; continue; }

    mergeApp({
      id: `woa.${app.slug || name.toLowerCase().replace(/[^a-z0-9]/g, '_')}`,
      name,
      publisher: app.publisher || null,
      arm_support,
      source: 'worksonwoa',
      source_url: `https://worksonwoa.com/en/apps/${app.slug}`,
      notes: app.categories ? `Categories: ${app.categories.join(', ')}` : null,
      confidence: getConfidence(app)
    });
    saved++;

    if (saved % 200 === 0) {
      console.log(`  Progress: ${saved} apps saved...`);
    }
  }

  console.log(`\n✓ Done! ${saved} apps saved, ${skipped} skipped.`);
}

// ─────────────────────────────────────────
//  Entry point
// ─────────────────────────────────────────

if (require.main === module) {
  runWorksonwoaScraper().catch(err => {
    console.error('Scraper failed:', err);
    process.exit(1);
  });
}

module.exports = { run: runWorksonwoaScraper };