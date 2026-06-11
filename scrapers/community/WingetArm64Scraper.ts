// scrapers/community/WingetArm64Scraper.ts

import { BaseScraper } from "../BaseScraper";
import { ArmNormalizedEntry } from "../types";
import yaml from "js-yaml";
import { promises as fs } from "fs";
import * as path from "path";

export class WingetArm64Scraper extends BaseScraper {
  name = "WingetArm64Scraper";
  source = "winget-pkgs";
  confidence = 0.95;

  private token = process.env.NGPCX_PAT;
  private headers = {
    "User-Agent": "NGPCX-Scraper",
    "Accept": "application/vnd.github+json",
    ...(this.token ? { Authorization: `Bearer ${this.token}` } : {})
  };

  private cacheDir = path.join(process.cwd(), ".cache", "winget");

  async scrape(): Promise<ArmNormalizedEntry[]> {
    console.log("[WingetArm64Scraper] Starting scrape…");

    await this.ensureCacheDir();

    const treeUrl =
      "https://api.github.com/repos/microsoft/winget-pkgs/git/trees/master?recursive=1";

    try {
      const res = await fetch(treeUrl, { headers: this.headers });
      if (!res.ok) {
        console.error("[WingetArm64Scraper] Tree returned", res.status);
        return [];
      }

      const tree = await res.json();

      const installerFiles = tree.tree.filter(
        (item: any) =>
          item.path.startsWith("manifests/") &&
          item.path.endsWith("installer.yaml")
      );

      console.log(
        `[WingetArm64Scraper] Found ${installerFiles.length} installer manifests…`
      );

      const concurrency = 25;
      const results: ArmNormalizedEntry[] = [];

      let index = 0;
      while (index < installerFiles.length) {
        const batch = installerFiles.slice(index, index + concurrency);
        index += concurrency;

        const batchResults = await Promise.all(
          batch.map((file: any) => this.processInstallerFile(file))
        );

        for (const r of batchResults) {
          if (r) results.push(r);
        }

        console.log(
          `[WingetArm64Scraper] Progress: ${Math.min(
            index,
            installerFiles.length
          )}/${installerFiles.length} (${results.length} ARM64 apps)`
        );
      }

      console.log(
        `[WingetArm64Scraper] Completed. Loaded ${results.length} ARM64 apps`
      );
      return results;
    } catch (err) {
      console.error("[WingetArm64Scraper] Failed to scrape winget-pkgs", err);
      return [];
    }
  }

  private async ensureCacheDir() {
    await fs.mkdir(this.cacheDir, { recursive: true });
  }

  private async processInstallerFile(file: any): Promise<ArmNormalizedEntry | null> {
    const sha = file.sha;
    const cachePath = path.join(this.cacheDir, `${sha}.yaml`);

    let yamlText: string;

    try {
      // cache first
      try {
        yamlText = await fs.readFile(cachePath, "utf8");
      } catch {
        const rawUrl = `https://raw.githubusercontent.com/microsoft/winget-pkgs/master/${file.path}`;
        const res = await fetch(rawUrl, { headers: this.headers });
        if (!res.ok) return null;

        yamlText = await res.text();
        await fs.writeFile(cachePath, yamlText, "utf8");
      }

      const manifest: any = yaml.load(yamlText);
      if (!manifest?.Installers) return null;

      const pkgId = manifest.PackageIdentifier;
      if (!pkgId || typeof pkgId !== "string") {
        console.warn(
          "[WingetArm64Scraper] Skipping manifest with invalid PackageIdentifier:",
          file.path
        );
        return null;
      }

      const hasArm64 = manifest.Installers.some(
        (i: any) => i.Architecture?.toLowerCase() === "arm64"
      );
      if (!hasArm64) return null;

      return {
        id: pkgId,
        name: manifest.PackageName ?? pkgId,
        publisher: manifest.Publisher,
        architectures: ["arm64"],
        armSupport: "native",
        source: "winget-pkgs",
        notes: "ARM64 installer available"
      };
    } catch (err) {
      console.warn(
        "[WingetArm64Scraper] Failed to process installer manifest:",
        file.path,
        err
      );
      return null;
    }
  }
}
