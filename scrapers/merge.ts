// scrapers/merge.ts

import fs from "fs";
import path from "path";
import { ScraperResult } from "./BaseScraper";
import { PROJECT_ROOT } from "utils/paths";

const DB_PATH = path.join(PROJECT_ROOT, "data", "compatibility.json");

export async function mergeIntoDatabase(results: ScraperResult[]) {
  let db: ScraperResult[] = [];

  // Load existing DB
  if (fs.existsSync(DB_PATH)) {
    const raw = fs.readFileSync(DB_PATH, "utf8");
    db = JSON.parse(raw);
  }

  for (const entry of results) {
    // Support both schemas:
    // - Old scrapers: entry.appId
    // - New scrapers: entry.id
    const id = entry.appId ?? entry.id;

    if (!id) {
      console.warn("Skipping entry with missing ID:", entry);
      continue;
    }

    const index = db.findIndex(e => (e.appId ?? e.id) === id);

    if (index === -1) {
      // New entry
      db.push({ ...entry, id });
      console.log(`Added new entry: ${id}`);
    } else {
      // Merge fields (simple overwrite)
      db[index] = {
        ...db[index],
        ...entry,
        id
      };
      console.log(`Updated entry: ${id}`);
    }
  }

  // Save DB
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
  console.log(`Database updated. Total entries: ${db.length}`);
}
