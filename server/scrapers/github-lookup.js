require('dotenv').config();
const { mergeApp } = require('./merge');

// On-demand, single-app GitHub lookup — different from winget.js, which
// searches *within* microsoft/winget-pkgs for manifest files. This searches
// GitHub broadly by app name and checks that repo's latest release assets.
// Confidence is set below every real data source's floor (worksonwoa is
// 0.75-0.90+) so mergeApp()'s existing conflict resolution never lets this
// silently override real data — it can only fill genuine gaps or reinforce
// an existing low-confidence match.

const HEADERS = {
  'Authorization': `Bearer ${process.env.GITHUB_TOKEN}`,
  'User-Agent': 'ngpcx-scraper',
  'Accept': 'application/vnd.github+json'
};

function normalize(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

async function apiFetch(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) return null;
  return res;
}

// Looks up a single app by name on GitHub. Fire-and-forget from the caller's
// perspective — never throws, always resolves (to a result summary or null).
async function lookupGithubForApp(name) {
  if (!name) return null;

  try {
    const query = encodeURIComponent(name);
    const searchRes = await apiFetch(`https://api.github.com/search/repositories?q=${query}&per_page=5`);
    if (!searchRes) return null;

    const searchData = await searchRes.json();
    const items = searchData.items || [];
    if (items.length === 0) return null;

    // Strict match on repo name only (not full_name) to avoid owner-name
    // noise, and to avoid guessing on a loosely-related "best match" result.
    const targetNorm = normalize(name);
    const repo = items.find((r) => normalize(r.name) === targetNorm);
    if (!repo) return null;

    const releaseRes = await apiFetch(`https://api.github.com/repos/${repo.full_name}/releases/latest`);
    if (!releaseRes) return null;

    const release = await releaseRes.json();
    const assets = release.assets || [];
    const armAsset = assets.find((a) => /arm64|aarch64/i.test(a.name));
    if (!armAsset) return null;

    mergeApp({
      id: `github_${targetNorm}`,
      name,
      arm_support: 'native',
      type: 'app',
      source: 'github-auto',
      source_url: release.html_url,
      notes: `Auto-detected via GitHub release scan (${repo.full_name}) — unverified, needs admin confirmation.`,
      confidence: 0.4
    });

    return { name, repo: repo.full_name, release_url: release.html_url };
  } catch (err) {
    console.error('  GitHub lookup failed for', name, '-', err.message);
    return null;
  }
}

module.exports = { lookupGithubForApp };
