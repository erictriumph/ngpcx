import { BaseScraper } from "../BaseScraper";
import { ArmNormalizedEntry } from "../types";
import yaml from "js-yaml";

export class WingetArm64FallbackScraper extends BaseScraper {
  name = "WingetArm64FallbackScraper";
  source = "winget-pkgs-fallback";
  confidence = 0.9;

  private token = process.env.NGPCX_PAT;
  private headers = {
    "User-Agent": "NGPCX-Scraper",
    "Accept": "application/vnd.github+json",
    ...(this.token ? { Authorization: `Bearer ${this.token}` } : {})
  };

  async scrape(): Promise<ArmNormalizedEntry[]> {
    console.log("[WingetArm64FallbackScraper] Starting fallback scrape…");

    const treeUrl =
      "https://api.github.com/repos/microsoft/winget-pkgs/git/trees/master?recursive=1";

    try {
      const res = await fetch(treeUrl, { headers: this.headers });
      if (!res.ok) {
        console.error("[WingetArm64FallbackScraper] Tree returned", res.status);
        return [];
      }

      const tree = await res.json();

      const installerFiles = tree.tree.filter(
        (item: any) =>
          item.path.startsWith("manifests/") &&
          item.path.endsWith("installer.yaml")
      );

      console.log(
        `[WingetArm64FallbackScraper] Found ${installerFiles.length} installer manifests…`
      );

      const results: ArmNormalizedEntry[] = [];

      for (const file of installerFiles) {
        const rawUrl = `https://raw.githubusercontent.com/microsoft/winget-pkgs/master/${file.path}`;
        const yamlText = await fetch(rawUrl, { headers: this.headers }).then(r =>
          r.text()
        );

        const manifest: any = yaml.load(yamlText);
        if (!manifest?.Installers) continue;

        const hasArm64 = manifest.Installers.some(
          (i: any) => i.Architecture?.toLowerCase() === "arm64"
        );

        if (!hasArm64) continue;

        results.push({
          id: manifest.PackageIdentifier,
          name: manifest.PackageName,
          publisher: manifest.Publisher,
          architectures: ["arm64"],
          armSupport: "native",
          source: "winget-pkgs-fallback",
          notes: "ARM64 installer available"
        });
      }

      console.log(
        `[WingetArm64FallbackScraper] Completed. Loaded ${results.length} ARM64 apps`
      );
      return results;
    } catch (err) {
      console.error(
        "[WingetArm64FallbackScraper] Failed to scrape winget-pkgs",
        err
      );
      return [];
    }
  }
}
