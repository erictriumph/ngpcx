require('dotenv').config();
const db = require('../db');

const HEADERS = {
  'Authorization': `Bearer ${process.env.GITHUB_TOKEN}`,
  'User-Agent': 'ngpcx-scraper',
  'Accept': 'application/vnd.github+json'
};

async function fetchWithRetry(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, { headers: HEADERS });
      if (res.status === 403) {
        console.log('Rate limited - waiting 60 seconds...');
        await new Promise(r => setTimeout(r, 60000));
        continue;
      }
      return res;
    } catch (err) {
      if (i === retries - 1) throw err;
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

async function processManifest(file) {
  try {
    const url = `https://raw.githubusercontent.com/microsoft/winget-pkgs/master/${file.path}`;
    const res = await fetchWithRetry(url);
    if (!res.ok) return null;

    const text = await res.text();

    // Check for ARM64 in the raw YAML without parsing
    if (!text.toLowerCase().includes('arm64')) return null;

    // Extract package info with simple regex
    const idMatch = text.match(/^PackageIdentifier:\s*(.+)$/m);
    const nameMatch = text.match(/^PackageName:\s*(.+)$/m);
    const publisherMatch = text.match(/^Publisher:\s*["']?(.+?)["']?\s*$/m);

    if (!idMatch) return null;

    const id = idMatch[1].trim();
    const name = nameMatch ? nameMatch[1].trim() : id;
    const publisher = publisherMatch ? publisherMatch[1].trim() : null;

    return { id, name, publisher };
  } catch {
    return null;
  }
}

function saveToDb(entry) {
  try {
    console.log('Saving:', entry.id);
    db.prepare(`
      INSERT INTO apps (id, name, publisher, arm_support, architectures, source, notes, confidence, last_updated)
      VALUES (?, ?, ?, 'native', 'arm64', 'winget', 'ARM64 installer available in winget', 0.95, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        publisher = excluded.publisher,
        arm_support = 'native',
        architectures = 'arm64',
        confidence = 0.95,
        last_updated = excluded.last_updated
    `).run(entry.id, entry.name, entry.publisher, new Date().toISOString());
  } catch(err) {
    console.error('Save failed for:', entry.id, '-', err.message);
  }
}

async function runWingetScraper() {
  console.log('Starting Winget ARM64 scraper...');

  const treeUrl = 'https://api.github.com/repos/microsoft/winget-pkgs/git/trees/master?recursive=1';
  const res = await fetchWithRetry(treeUrl);
  const tree = await res.json();

  const installerFiles = tree.tree.filter(item =>
    item.path.startsWith('manifests/') &&
    item.path.endsWith('.installer.yaml')
  );

  console.log(`Found ${installerFiles.length} installer manifests to check...`);

  const BATCH_SIZE = 20;
  let found = 0;
  let processed = 0;

  for (let i = 0; i < installerFiles.length; i += BATCH_SIZE) {
    const batch = installerFiles.slice(i, i + BATCH_SIZE);

    const results = await Promise.all(batch.map(processManifest));

    const validResults = results.filter(r => r !== null);
    if (validResults.length > 0) {
      console.log(`Batch ${i}-${i+BATCH_SIZE}: ${validResults.length} valid results`);
    }

    for (const result of validResults) {
      if (!result.id || !result.name) {
        console.log('Invalid:', result);
        continue;
      }
      saveToDb(result);
      found++;
    }

    processed += batch.length;

    if (processed % 500 === 0) {
      console.log(`Progress: ${processed}/${installerFiles.length} checked, ${found} ARM64 apps found`);
    }
  }

  console.log(`\nDone! Found ${found} ARM64 apps out of ${processed} packages checked.`);
  console.log('Database updated.');
  process.exit(0);
}

runWingetScraper().catch(err => {
  console.error('Scraper failed:', err);
  process.exit(1);
});