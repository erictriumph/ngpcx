// /scrapers/community/TopAppsScraper.ts

import { BaseScraper } from "../BaseScraper";
import fs from "fs";
import path from "path";

export class TopAppsScraper extends BaseScraper {
  name = "TopAppsScraper";
  source = "curated-top-apps";
  confidence = 0.9; // curated list = high confidence

  async scrape(): Promise<any[]> {
    const file = path.join(__dirname, "topApps.json");

    if (!fs.existsSync(file)) {
      console.error("[TopAppsScraper] Missing topApps.json");
      return [];
    }

    const apps = JSON.parse(fs.readFileSync(file, "utf8"));

    return apps.map((app: any) => ({
      id: app.id,
      name: app.name,
      publisher: app.publisher,
      categories: app.categories,
      armSupportLevel: app.armSupportLevel,
      url: app.url,
      icon: app.icon
    }));
  }
}
