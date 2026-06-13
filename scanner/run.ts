import fs from "fs";
import { DATA_DIR, SCAN_RESULTS_FILE } from "utils/paths";
import { validatePaths } from "utils/pathValidator";
import { runLocalScanner } from "./localScanner";
import { enrichWithStoreArch } from "./storeScanner";
import { enrichWithDrivers } from "./driverScanner";
import { generateReadinessReport, printReadinessReport } from "./report";

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

async function main() {
  const installedApps = await runLocalScanner();

  if (!installedApps || installedApps.length === 0) {
    console.log("No scan results produced.");
    return;
  }

  enrichWithStoreArch(installedApps);
  enrichWithDrivers(installedApps);

  const report = generateReadinessReport(installedApps);
  printReadinessReport(report);

  const output = {
    generatedAt: new Date().toISOString(),
    lastScanned: new Date().toISOString(),
    apps: installedApps,
    report,
    native: report.native,
    emulated: report.emulated,
    unsupported: report.incompatible
  };

  writeJsonOutput(output);
}

main().catch((err) => {
  console.error("Scanner failed:", err);
  process.exit(1);
});
