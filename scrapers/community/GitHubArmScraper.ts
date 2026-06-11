import { BaseScraper } from "../BaseScraper";
import yaml from "js-yaml";

export class GitHubArmScraper extends BaseScraper {
  name = "GitHubArmScraper";
  source = "github";
  confidence = 0.75;

  private repos = [
    {
      repo: "microsoft/Windows-on-ARM",
      type: "markdown",
      path: "README.md"
    },
    {
      repo: "woa-community/Windows-ARM-Compatibility",
      type: "markdown",
      path: "README.md"
    },
    {
      repo: "arm64-apps/windows-arm64-compatibility",
      type: "yaml-folder",
      path: "_data/apps"
    }
  ];

  private getHeaders() {
    const headers: any = {
      "User-Agent": "NGPCX-Scraper",
      "Accept": "application/vnd.github.v3.raw"
    };

    if (process.env.NGPCX_PAT) {
      headers.Authorization = `Bearer ${process.env.NGPCX_PAT}`;
    }

    return headers;
  }

  protected async scrape(): Promise<any[]> {
    console.log(`[${this.name}] Starting scrape…`);

    const results: any[] = [];

    for (const repo of this.repos) {
      console.log(`[${this.name}] Fetching ${repo.repo}`);

      try {
        const branch = await this.getDefaultBranch(repo.repo);

        if (repo.type === "markdown") {
          const md = await this.fetchRawFile(repo.repo, branch, repo.path);
          if (md) results.push(...this.parseMarkdownTable(md));
        }

        if (repo.type === "yaml-folder") {
          const files = await this.fetchYamlFolder(repo.repo, branch, repo.path);
          results.push(...files);
        }
      } catch (err) {
        console.log(
          `[${this.name}] Error processing ${repo.repo}: ${(err as Error).message}`
        );
      }
    }

    console.log(`[${this.name}] Completed scrape.`);
    return results;
  }

  private async getDefaultBranch(repo: string): Promise<string> {
    const url = `https://api.github.com/repos/${repo}`;
    const res = await fetch(url, { headers: this.getHeaders() });

    if (!res.ok) {
      console.log(`[${this.name}] Failed to get default branch for ${repo}`);
      return "main";
    }

    const json = await res.json();
    return json.default_branch || "main";
  }

  private async fetchRawFile(repo: string, branch: string, path: string): Promise<string | null> {
    const url = `https://raw.githubusercontent.com/${repo}/${branch}/${path}`;

    const res = await fetch(url, { headers: this.getHeaders() });

    if (!res.ok) {
      console.log(`[${this.name}] Failed to fetch ${repo}/${path} (HTTP ${res.status})`);
      return null;
    }

    return await res.text();
  }

  private parseMarkdownTable(md: string): any[] {
    const lines = md.split("\n");
    const entries: any[] = [];

    for (const line of lines) {
      if (!line.startsWith("|")) continue;
      if (line.includes("---")) continue;

      const cols = line.split("|").map(c => c.trim());
      if (cols.length < 3) continue;

      const name = cols[1];
      const status = cols[2];
      const notes = cols[3] || "";

      if (!name || name === "App" || name === "Name") continue;

      const appId = this.slugify(name);

      entries.push({
        appId,
        name,
        armSupport: {
          native: this.isNative(status),
          emulation: this.isEmulated(status),
          rosetta: false,
          notes
        },
        compatibility: {
          status: this.mapStatus(status),
          issues: [],
          workarounds: []
        }
      });
    }

    return entries;
  }

  private async fetchYamlFolder(repo: string, branch: string, folder: string): Promise<any[]> {
    const apiUrl = `https://api.github.com/repos/${repo}/contents/${folder}?ref=${branch}`;
    const res = await fetch(apiUrl, { headers: this.getHeaders() });

    if (!res.ok) {
      console.log(`[${this.name}] Failed to list YAML folder (HTTP ${res.status})`);
      return [];
    }

    const files = await res.json();
    const results: any[] = [];

    for (const file of files) {
      if (!file.name.endsWith(".yml") && !file.name.endsWith(".yaml")) continue;

      const raw = await this.fetchRawFile(repo, branch, `${folder}/${file.name}`);
      if (!raw) continue;

      try {
        const data: any = yaml.load(raw);
        if (!data || !data.name) continue;

        results.push({
          appId: data.packageId || this.slugify(data.name),
          name: data.name,
          armSupport: {
            native: this.isNative(data.status),
            emulation: this.isEmulated(data.status),
            rosetta: false,
            notes: data.notes || ""
          },
          compatibility: {
            status: this.mapStatus(data.status),
            issues: [],
            workarounds: []
          }
        });
      } catch (err) {
        console.log(`[${this.name}] YAML parse error: ${(err as Error).message}`);
      }
    }

    return results;
  }

  private slugify(name: string): string {
    return name
      .toLowerCase()
      .replace(/\s+/g, "-")
      .replace(/[^a-z0-9.-]/g, "");
  }

  private mapStatus(status?: string): string {
    if (!status) return "unknown";
    const s = status.toLowerCase();

    if (s.includes("native")) return "native";
    if (s.includes("works")) return "works";
    if (s.includes("partial")) return "partial";
    if (s.includes("broken")) return "broken";

    return "unknown";
  }

  private isNative(status?: string): boolean {
    return status?.toLowerCase().includes("native") || false;
  }

  private isEmulated(status?: string): boolean {
    return status?.toLowerCase().includes("works") || false;
  }
}
