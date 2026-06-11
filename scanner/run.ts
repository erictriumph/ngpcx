// /scanner/run.ts

import { runLocalScanner } from "./localScanner";
import { enrichWithStoreArch } from "./storeScanner";
import { enrichWithDrivers } from "./driverScanner";
import { generateReadinessReport, printReadinessReport } from "./report";

async function main() {
  const apps = await runLocalScanner();

  enrichWithStoreArch(apps);
  enrichWithDrivers(apps);

  const report = generateReadinessReport(apps);
  printReadinessReport(report);

  console.log("\n=== ARM Readiness Report ===");

  console.log("\nNative ARM64 available:");
  report.native.forEach(a => console.log(" -", a.name));

  console.log("\nRuns under x64 emulation:");
  report.emulated.forEach(a => console.log(" -", a.name));

  console.log("\nx86-only (slowest):");
  report.x86only.forEach(a => console.log(" -", a.name));

  console.log("\nKnown incompatible:");
  report.incompatible.forEach(a => console.log(" -", a.name));

  console.log("\nUnknown / not in database:");
  report.unknown.forEach(a => console.log(" -", a.name));
}

main();
