import { promises as fs } from "fs";
import path from "path";
import { ArmNormalizedEntry } from "../scrapers/types";

const DB_PATH = path.join(process.cwd(), "data", "armApps.json");

export async function saveArmEntries(entries: ArmNormalizedEntry[]) {
  // Load existing DB
  let existing: ArmNormalizedEntry[] = [];

  try {
    const raw = await fs.readFile(DB_PATH, "utf8");
    existing = JSON.parse(raw);
  } catch {
    existing = [];
  }

  const map = new Map(existing.map(e => [e.id, e]));

  for (const entry of entries) {
    if (!entry.id || typeof entry.id !== "string") {
      console.warn("Skipping entry with invalid id:", entry);
      continue;
    }

    map.set(entry.id, entry);
    console.log("Updated entry:", entry.id);
  }

  const updated = Array.from(map.values());

  await fs.writeFile(DB_PATH, JSON.stringify(updated, null, 2), "utf8");

  console.log(`Database updated. Total entries: ${updated.length}`);
}
