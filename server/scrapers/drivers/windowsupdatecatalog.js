const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const { mergeApp } = require('../merge');

const CACHE_DIR = path.join(__dirname, '../../../.cache/windowsupdatecatalog');
const SEARCH_URL = 'https://www.catalog.update.microsoft.com/Search.aspx';

// Curated peripheral keywords — the "low-lift" starting set.
// Core WoA hardware (WiFi/GPU) ships pre-installed; the real driver
// gap is peripherals users plug in after the fact.
const SEARCH_TERMS = [
  'HP LaserJet ARM64',
  'Canon printer ARM64',
  'Epson printer ARM64',
  'Brother printer ARM64',
  'Logitech webcam ARM64',
  'Focusrite ARM64',
  'Elgato ARM64',
  'Wacom ARM64',
  'Fujitsu scanner ARM64',
  'Brother scanner ARM64'
];

// ─────────────────────────────────────────
//  Cache helpers
// ─────────────────────────────────────────

function ensureCacheDir() {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
}

function cacheKey(str) {
  return str.replace(/[^a-z0-9]/gi, '_').toLowerCase();
}

function fromCache(key) {
  const file = path.join(CACHE_DIR, key + '.json');
  if (fs.existsSync(file)) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  return null;
}

function toCache(key, data) {
  const file = path.join(CACHE_DIR, key + '.json');
  fs.writeFileSync(file, JSON.stringify(data), 'utf8');
}

// ─────────────────────────────────────────
//  Search the catalog (first page only — see notes)
// ─────────────────────────────────────────

async function searchCatalog(term) {
  const key = `search_${cacheKey(term)}`;
  const cached = fromCache(key);
  if (cached) return cached;

  const url = `${SEARCH_URL}?q=${encodeURIComponent(term)}`;

  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ngpcx-scraper'
    }
  });

  if (!res.ok) {
    console.log(`  Search failed for "${term}": HTTP ${res.status}`);
    return [];
  }

  const html = await res.text();
    
  // TEMP DEBUG — remove after
  fs.writeFileSync(path.join(CACHE_DIR, 'debug_raw.html'), html, 'utf8');
  console.log(`  [debug] saved ${html.length} bytes to debug_raw.html`);
  
  const results = parseResultsTable(html);

  toCache(key, results);
  return results;
}

// ─────────────────────────────────────────
//  Parse the results table
// ─────────────────────────────────────────

function parseResultsTable(html) {
  const $ = cheerio.load(html);
  const rows = [];

  $('table#ctl00_catalogBody_updateMatches tr').each((i, el) => {
    const cells = $(el).find('td');
    if (cells.length < 6) return; // header row or malformed row

    const title = $(cells[1]).text().trim();
    const products = $(cells[2]).text().trim();
    const classification = $(cells[3]).text().trim();
    const lastUpdated = $(cells[4]).text().trim();
    const version = $(cells[5]).text().trim();

    if (!title) return;

    rows.push({ title, products, classification, lastUpdated, version });
  });

  return rows;
}

// ─────────────────────────────────────────
//  Filter + normalize into driver entries
// ─────────────────────────────────────────

function extractDriverEntries(results, searchTerm) {
  const entries = [];

  for (const r of results) {
    const titleLower = r.title.toLowerCase();
    const isArm64 = titleLower.includes('arm64') || titleLower.includes('arm 64');
    const isDriver = r.classification.toLowerCase().includes('driver');

    if (!isArm64 || !isDriver) continue;

    // Try to pull a vendor name off the front of the search term
    const publisher = searchTerm.split(' ')[0];

    entries.push({
      name: r.title,
      publisher,
      arm_support: 'native',
      type: 'driver',
      source: 'windows_update_catalog',
      source_url: SEARCH_URL,
      notes: `Found via Windows Update Catalog search: "${searchTerm}" (${r.classification}, ${r.lastUpdated})`,
      confidence: 0.85
    });
  }

  return entries;
}

// ─────────────────────────────────────────
//  Save to database
// ─────────────────────────────────────────

function saveToDb(entry) {
  mergeApp({
    id: `wuc_${cacheKey(entry.name)}`,
    name: entry.name,
    publisher: entry.publisher,
    arm_support: entry.arm_support,
    type: entry.type,
    source: entry.source,
    source_url: entry.source_url,
    notes: entry.notes,
    confidence: entry.confidence
  });
}

// ─────────────────────────────────────────
//  Main scraper
// ─────────────────────────────────────────

async function runWindowsUpdateCatalogScraper() {
  console.log('Starting Windows Update Catalog driver scraper...\n');
  ensureCacheDir();

  let totalFound = 0;

  for (const term of SEARCH_TERMS) {
    process.stdout.write(`Searching "${term}"... `);

    const results = await searchCatalog(term);
    const entries = extractDriverEntries(results, term);

    process.stdout.write(`${results.length} results, ${entries.length} ARM64 drivers\n`);

    for (const entry of entries) {
      saveToDb(entry);
      totalFound++;
      console.log(`  ✓ ${entry.name}`);
    }

    // Be polite — this is a public search page, not an API
    await new Promise(r => setTimeout(r, 2000));
  }

  console.log(`\n✓ Done! ${totalFound} ARM64 drivers saved to database.`);
  console.log('\nNote: this pass only covers the first results page per search term.');
  console.log('Deeper pagination requires ASP.NET viewstate/postback handling — a good next iteration.');
}

// ─────────────────────────────────────────
//  Entry point
// ─────────────────────────────────────────

if (require.main === module) {
  runWindowsUpdateCatalogScraper().catch(err => {
    console.error('Scraper failed:', err);
    process.exit(1);
  });
}

module.exports = { run: runWindowsUpdateCatalogScraper };