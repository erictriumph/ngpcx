import { BaseScraper, ScraperResult } from "../BaseScraper";
// no import needed — fetch is global in Node 18+

interface GitHubAppEntry {
  appId: string;
  name: string;
  publisher?: string;
  categories?: string[];
  armSupport: {
    native: boolean;
    emulation: boolean;
    rosetta: boolean;
    notes?: string;
  };
  compatibility: {
    status: string;
    issues?: string[];
    workarounds?: string[];
  };
}

export class GitHubArmScraper extends BaseScraper {
  name = "GitHubArmScraper";
  source = "github";
  confidence = 0.7;

  // Repos that track Windows-on-ARM compatibility
  repos = [
    "microsoft/Windows-on-ARM",
    "woa-community/Windows-ARM-Compatibility",
    "arm64-apps/windows-arm64-compatibility"
  ];

  async scrape(): Promise<GitHubAppEntry[]> {
    const results: GitHubAppEntry[] = [];

    for (const repo of this.repos) {
      console.log(`[GitHubArmScraper] Fetching data from ${repo}`);

      const url = `https://api.github.com/repos/${repo}/contents/compatibility.json`;

      try {
        const res = await fetch(url, {
          headers: {
            "User-Agent": "NGPCX-Scraper",
            "Accept": "application/vnd.github.v3+json"
          }
        });

        if (!res.ok) {
          console.warn(`[GitHubArmScraper] Failed to fetch ${repo}`);
          continue;
        }

        const json = await res.json();

        // GitHub returns file contents base64-encoded
        const decoded = Buffer.from(json.content, "base64").toString("utf8");
        const parsed = JSON.parse(decoded);

        for (const entry of parsed.apps || parsed) {
          results.push({
            appId: entry.appId || this.slugify(entry.name),
            name: entry.name,
            publisher: entry.publisher || null,
            categories: entry.categories || [],
            armSupport: {
              native: entry.native || false,
              emulation: entry.emulation || false,
              rosetta: false,
              notes: entry.notes || ""
            },
            compatibility: {
              status: entry.status || "unknown",
              issues: entry.issues || [],
              workarounds: entry.workarounds || []
            }
          });
        }
      } catch (err) {
        console.error(`[GitHubArmScraper] Error scraping ${repo}:`, err);
      }
    }

    return results;
  }

  // Converts "Adobe Photoshop" → "com.adobe.photoshop"
  private slugify(name: string): string {
    return (
      "com." +
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ".")
        .replace(/\.+/g, ".")
        .replace(/^\./, "")
        .replace(/\.$/, "")
    );
  }
}
