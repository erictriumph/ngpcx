require('dotenv').config();
const { mergeApp } = require('./merge');

// On-demand, single-app GitHub lookup — different from winget.js, which
// searches *within* microsoft/winget-pkgs for manifest files. This searches
// GitHub broadly by app name and checks that repo's latest release assets.
// Confidence (0.70) sits in a similar range to WorksOnWoA but stays strictly
// below its lowest tier (0.75, community-validated) — so mergeApp()'s
// existing conflict resolution still never lets this silently override a
// real source, only fill genuine gaps or reinforce agreement with another
// github-auto match. The star-count gate below is the other half of that
// caution: a wrong match is worse than no match.

const HEADERS = {
  'Authorization': `Bearer ${process.env.GITHUB_TOKEN}`,
  'User-Agent': 'ngpcx-scraper',
  'Accept': 'application/vnd.github+json'
};

function normalize(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Below this, treat a name match as too likely to be an obscure/abandoned/
// unrelated repo that just happens to share a normalized name. Easy to tune.
const MIN_STARS = 20;

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

    // Sanity-check against star count — record "no confident match" rather
    // than guessing on an obscure repo that just happens to share a name.
    if ((repo.stargazers_count || 0) < MIN_STARS) return null;

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
      notes: `Auto-detected via GitHub release scan (${repo.full_name}, ${repo.stargazers_count} stars) — unverified, needs admin confirmation.`,
      confidence: 0.70
    });

    return { name, repo: repo.full_name, release_url: release.html_url };
  } catch (err) {
    console.error('  GitHub lookup failed for', name, '-', err.message);
    return null;
  }
}

module.exports = { lookupGithubForApp };
