// /scrapers/community/WingetPartialScraper.ts

import { BaseScraper } from "../BaseScraper";

export class WingetPartialScraper extends BaseScraper {
  name = "WingetPartialScraper";
  source = "winget-partial";
  confidence = 0.85;

  async scrape(): Promise<any[]> {
    const url = "https://api.github.com/repos/microsoft/winget-pkgs/contents/manifests";
    const res = await fetch(url);
    if (!res.ok) return [];

    const dirs = await res.json();

    // Limit to ~500 most popular manifests
    const limited = dirs.slice(0, 500);

    const results: any[] = [];

    for (const entry of limited) {
      if (!entry.name) continue;

      results.push({
        id: entry.name.toLowerCase(),
        name: entry.name,
        publisher: "Unknown",
        categories: [],
        armSupportLevel: "unknown",
        url: entry.html_url,
        icon: ""
      });
    }

    return results;
  }
}
