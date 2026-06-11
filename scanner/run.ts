// /scanner/run.ts

import { runLocalScanner } from "./localScanner";
import { enrichWithStoreArch } from "./storeScanner";
import { enrichWithDrivers } from "./driverScanner";
import {
  generateReadinessReport,
  printReadinessReport
} from "./report";
import { ensureExeIndex } from "./localScanner";

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
}

main();
