// /scanner/run.ts

import { runLocalScanner } from "./localScanner";
import { enrichWithStoreArch } from "./storeScanner";
import { enrichWithDrivers } from "./driverScanner";
import {
  generateReadinessReport,
  printReadinessReport
} from "./report";
import { ensureExeIndex } from "./localScanner";
import fs from "fs";
import path from "path";

async function main() {
  console.log("=== NGPCX Scanner ===");

  //
  // Warm or rebuild EXE index
  //
  const force = process.argv.includes("--force");
  ensureExeIndex(force);

  //
  // Local EXE + architecture scan
  //
  const apps = await runLocalScanner();

  //
  // Store MSIX ARM64 detection
  //
  enrichWithStoreArch(apps);

  //
  // Driver compatibility detection
  //
  enrichWithDrivers(apps);

  //
  // ARM readiness scoring + report
  //
  const report = generateReadinessReport(apps);
  printReadinessReport(report);

  writeJsonOutput(report);
}

function writeJsonOutput(results: any) {
  //
  // FIXED: Write to project-root /data/scan-results.json
  //
  const outputDir = path.join(process.cwd(), "data");
  const outputPath = path.join(outputDir, "scan-results.json");

  try {
    // Ensure /data exists
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    // Write JSON
    fs.writeFileSync(outputPath, JSON.stringify(results, null, 2), "utf8");
    console.log(`✔ Scan results written to ${outputPath}`);
  } catch (err) {
    console.error("Failed to write scan-results.json:", err);
  }
}

main();
