// /scrapers/community/GitHubPopularScraper.ts

import { BaseScraper } from "../BaseScraper";

const POPULAR_REPOS = [
  {
    id: "notepad-plus-plus/notepad-plus-plus",
    name: "Notepad++",
    armSupportLevel: "x86-emulated",
    categories: ["Developer Tools"]
  },
  {
    id: "qbittorrent/qBittorrent",
    name: "qBittorrent",
    armSupportLevel: "x64-emulated",
    categories: ["Utilities"]
  },
  {
    id: "ShareX/ShareX",
    name: "ShareX",
    armSupportLevel: "x64-emulated",
    categories: ["Utilities"]
  },
  {
    id: "obsproject/obs-studio",
    name: "OBS Studio",
    armSupportLevel: "native",
    categories: ["Media"]
  },
  {
    id: "GyanD/codexffmpeg",
    name: "FFmpeg",
    armSupportLevel: "native",
    categories: ["Media"]
  }
];

export class GitHubPopularScraper extends BaseScraper {
  name = "GitHubPopularScraper";
  source = "github-popular";
  confidence = 0.8;

  async scrape(): Promise<any[]> {
    const results: any[] = [];

    for (const repo of POPULAR_REPOS) {
      const apiUrl = `https://api.github.com/repos/${repo.id}`;

      try {
        const res = await fetch(apiUrl);
        if (!res.ok) continue;

        const data = await res.json();

        results.push({
          id: repo.id,
          name: repo.name,
          publisher: data.owner?.login ?? "Unknown",
          categories: repo.categories,
          armSupportLevel: repo.armSupportLevel,
          url: data.html_url,
          icon: data.owner?.avatar_url ?? ""
        });
      } catch {
        continue;
      }
    }

    return results;
  }
}
