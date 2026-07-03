require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { mergeApp } = require('./merge');

const HEADERS = {
  'Authorization': `Bearer ${process.env.GITHUB_TOKEN}`,
  'User-Agent': 'ngpcx-scraper',
  'Accept': 'application/vnd.github+json'
};

const CACHE_DIR = path.join(__dirname, '../../.cache/winget');
const RAW = 'https://raw.githubusercontent.com/microsoft/winget-pkgs/master';

// ─────────────────────────────────────────
//  Cache helpers
// ─────────────────────────────────────────

function ensureCacheDir() {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
}

function cacheKey(str) {
  return str.replace(/[^a-z0-9]/gi, '_').substring(0, 100);
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
//  Rate limit check — proactive
// ─────────────────────────────────────────

async function checkRateLimit() {
  const res = await fetch('https://api.github.com/rate_limit', { headers: HEADERS });
  if (!res.ok) return;

  const data = await res.json();
  const search = data.resources.search;
  const resetIn = Math.round((search.reset * 1000 - Date.now()) / 1000);

  if (search.remaining < 5) {
    const wait = Math.max(search.reset * 1000 - Date.now(), 10000);
    console.log(`\n  ⚠ Low on search requests (${search.remaining} left) — waiting ${Math.round(wait / 1000)}s...`);
    await new Promise(r => setTimeout(r, wait));
  } else if (search.remaining < 15) {
    console.log(`  Rate limit: ${search.remaining} remaining, resets in ${resetIn}s`);
  }
}

// ─────────────────────────────────────────
//  Rate limit aware fetch
// ─────────────────────────────────────────

async function apiFetch(url) {
  const res = await fetch(url, { headers: HEADERS });

  if (res.status === 403 || res.status === 429) {
    const reset = parseInt(res.headers.get('x-ratelimit-reset') || '0') * 1000;
    const wait = Math.max(reset - Date.now(), 60000);
    console.log(`\n  Rate limited — waiting ${Math.round(wait / 1000)}s...`);
    await new Promise(r => setTimeout(r, wait));
    return apiFetch(url);
  }

  if (!res.ok) return null;
  return res;
}

// ─────────────────────────────────────────
//  Get vendor subfolders for a letter
// ─────────────────────────────────────────

async function getVendors(letter) {
  const key = `vendors_${letter}`;
  const cached = fromCache(key);
  if (cached) return cached;

  await checkRateLimit();
  await new Promise(r => setTimeout(r, 1000));

  const res = await apiFetch(
    `https://api.github.com/repos/microsoft/winget-pkgs/contents/manifests/${letter}`
  );
  if (!res) return [];

  const data = await res.json();
  const vendors = Array.isArray(data)
    ? data.filter(v => v.type === 'dir').map(v => v.name)
    : [];

  toCache(key, vendors);
  return vendors;
}

// ─────────────────────────────────────────
//  Search GitHub for ARM64 installer YAMLs
// ─────────────────────────────────────────

async function searchForPath(searchPath) {
  await checkRateLimit();
  await new Promise(r => setTimeout(r, 2000));

  const query = encodeURIComponent(
    `arm64 repo:microsoft/winget-pkgs path:${searchPath} filename:installer.yaml`
  );
  const url = `https://api.github.com/search/code?q=${query}&per_page=100`;

  const res = await apiFetch(url);
  if (!res) return { items: [], total: 0 };

  const data = await res.json();
  let items = [...(data.items || [])];
  const total = data.total_count || 0;

  // Fetch additional pages if needed
  if (total > 100 && total < 1000) {
    const pages = Math.min(Math.ceil(total / 100), 10);
    for (let page = 2; page <= pages; page++) {
      await checkRateLimit();
      await new Promise(r => setTimeout(r, 2000));
      const pageRes = await apiFetch(`${url}&page=${page}`);
      if (!pageRes) break;
      const pageData = await pageRes.json();
      items = [...items, ...(pageData.items || [])];
    }
  }

  return { items, total };
}

async function searchArm64Files(letter) {
  const cacheKeyStr = `search_${letter}`;
  const cached = fromCache(cacheKeyStr);
  if (cached) return cached;

  const { items, total } = await searchForPath(`manifests/${letter}`);

  // If we hit the 1000 cap, sub-search by vendor
  if (total >= 1000) {
    console.log(`\n  /${letter} has ${total}+ results — sub-searching by vendor...`);

    const vendors = await getVendors(letter);
    console.log(`  Found ${vendors.length} vendors under /${letter}`);

    let allItems = [];

    for (const vendor of vendors) {
      const { items: vendorItems, total: vendorTotal } = await searchForPath(
        `manifests/${letter}/${vendor}`
      );
      allItems = [...allItems, ...vendorItems];

      if (vendorTotal >= 1000) {
        console.log(`  ⚠ ${vendor} also hit the cap — may be incomplete`);
      }
    }

    console.log(`  Sub-search complete: ${allItems.length} total hits for /${letter}`);
    toCache(cacheKeyStr, allItems);
    return allItems;
  }

  toCache(cacheKeyStr, items);
  return items;
}

// ─────────────────────────────────────────
//  Get latest version path from search results
// ─────────────────────────────────────────

function getLatestVersionPaths(items) {
  const packages = {};

  for (const item of items) {
    const parts = item.path.split('/');
    if (parts.length < 6) continue;

    const packageKey = parts.slice(0, 4).join('/');
    const version = parts[4];

    if (!packages[packageKey]) {
      packages[packageKey] = { path: item.path, version };
    } else {
      if (version.localeCompare(packages[packageKey].version,
        undefined, { numeric: true }) > 0) {
        packages[packageKey] = { path: item.path, version };
      }
    }
  }

  return Object.values(packages);
}

// ─────────────────────────────────────────
//  Fetch and parse a single installer YAML
// ─────────────────────────────────────────

async function parseInstallerYaml(filePath) {
  const key = cacheKey(filePath);
  const cached = fromCache(key);
  if (cached) return cached;

  const res = await fetch(`${RAW}/${filePath}`, { headers: HEADERS });
  if (!res.ok) return null;

  const text = await res.text();
  if (!text.toLowerCase().includes('arm64')) return null;

  const idMatch = text.match(/^PackageIdentifier:\s*(.+)$/m);
  const nameMatch = text.match(/^PackageName:\s*(.+)$/m);
  const publisherMatch = text.match(/^Publisher:\s*["']?(.+?)["']?\s*$/m);

  if (!idMatch) return null;

  const result = {
    id: idMatch[1].trim(),
    name: nameMatch ? nameMatch[1].trim() : idMatch[1].trim(),
    publisher: publisherMatch ? publisherMatch[1].trim() : null,
    source_url: `https://github.com/microsoft/winget-pkgs/blob/master/${filePath}`
  };

  toCache(key, result);
  return result;
}

// ─────────────────────────────────────────
//  Save to database
// ─────────────────────────────────────────

function saveToDb(entry) {
  mergeApp({
    id: entry.id,
    name: entry.name,
    publisher: entry.publisher,
    arm_support: 'native',
    source: 'winget',
    source_url: entry.source_url,
    notes: 'ARM64 installer available in winget',
    confidence: 0.95
  });
}

// ─────────────────────────────────────────
//  Main scraper
// ─────────────────────────────────────────

async function runWingetScraper() {
  console.log('Starting Winget ARM64 scraper (search-based)...\n');
  ensureCacheDir();

  const args = process.argv.slice(2);
  const letterArg = args.find(a => a.startsWith('--letters='));
  const letters = letterArg
    ? letterArg.replace('--letters=', '').split(',')
    : '0123456789abcdefghijklmnopqrstuvwxyz'.split('');

  console.log(`Scanning ${letters.length} letter folder(s) via GitHub search...\n`);

  let totalFound = 0;
  let totalChecked = 0;

  for (const letter of letters) {
    process.stdout.write(`Searching /${letter}... `);

    const items = await searchArm64Files(letter);
    const latest = getLatestVersionPaths(items);

    process.stdout.write(`${items.length} hits, ${latest.length} unique packages\n`);

    const BATCH = 10;
    for (let i = 0; i < latest.length; i += BATCH) {
      const batch = latest.slice(i, i + BATCH);
      const results = await Promise.all(
        batch.map(pkg => parseInstallerYaml(pkg.path))
      );

      for (const result of results) {
        totalChecked++;
        if (result) {
          saveToDb(result);
          totalFound++;
          console.log(`  ✓ ${result.name} (${result.id})`);
        }
      }

      if (totalFound % 50 === 0 && totalFound > 0) {
        console.log(`\n  [Running total: ${totalFound} ARM64 apps found]\n`);
      }
    }
  }

  console.log(`\n✓ Done! ${totalFound} ARM64 apps saved to database.`);
}

// ─────────────────────────────────────────
//  Entry point
// ─────────────────────────────────────────

if (require.main === module) {
  runWingetScraper().catch(err => {
    console.error('Scraper failed:', err);
    process.exit(1);
  });
}

module.exports = { run: runWingetScraper };