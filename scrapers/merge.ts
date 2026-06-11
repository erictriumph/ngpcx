import fs from "fs";
import path from "path";
import { ScraperResult } from "./BaseScraper";

const DB_PATH = path.join(process.cwd(), "data", "compatibility.json");

export async function mergeIntoDatabase(results: ScraperResult[]) {
  let db: ScraperResult[] = [];

  // Load existing DB
  if (fs.existsSync(DB_PATH)) {
    const raw = fs.readFileSync(DB_PATH, "utf8");
    db = JSON.parse(raw);
  }

  for (const entry of results) {
    const index = db.findIndex(e => e.appId === entry.appId);

    if (index === -1) {
      // New entry
      db.push(entry);
      console.log(`Added new entry: ${entry.appId}`);
    } else {
      // Merge fields (simple overwrite for now)
      db[index] = {
        ...db[index],
        ...entry,
        verification: entry.verification
      };
      console.log(`Updated entry: ${entry.appId}`);
    }
  }

  // Save DB
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
  console.log(`Database updated. Total entries: ${db.length}`);
}
