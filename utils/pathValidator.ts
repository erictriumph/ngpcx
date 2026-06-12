import fs from "fs";
import { PROJECT_ROOT, DATA_DIR, SCAN_RESULTS_FILE } from "utils/paths";

export function validatePaths(context: string) {
  if (process.env.NODE_ENV !== "development") return;

  console.log("\n===============================");
  console.log(`🔍 PATH VALIDATOR (${context})`);
  console.log("===============================\n");

  console.log("PROJECT_ROOT:");
  console.log("  ", PROJECT_ROOT, "\n");

  console.log("DATA_DIR:");
  console.log("  ", DATA_DIR, "\n");

  console.log("SCAN_RESULTS_FILE:");
  console.log("  ", SCAN_RESULTS_FILE);
  console.log("  Exists:", fs.existsSync(SCAN_RESULTS_FILE), "\n");

  console.log("================================\n");
}
