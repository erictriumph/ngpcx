import fs from "fs";
import { DATA_DIR, SCAN_RESULTS_FILE } from "utils/paths";
import { validatePaths } from "utils/pathValidator";

validatePaths("SCANNER");

export function writeJsonOutput(results: any) {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }

    fs.writeFileSync(SCAN_RESULTS_FILE, JSON.stringify(results, null, 2), "utf8");
    console.log(`✔ Scan results written to ${SCAN_RESULTS_FILE}`);
  } catch (err) {
    console.error("Failed to write scan-results.json:", err);
  }
}
