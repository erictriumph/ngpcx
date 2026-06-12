import path from "path";
import fs from "fs";

export function validatePaths(context: string) {
  if (process.env.NODE_ENV !== "development") return;

  const cwd = process.cwd();
  const projectRoot = path.join(cwd, "..");
  const expectedDataFile = path.join(projectRoot, "data", "scan-results.json");
  const uiDataFile = path.join(cwd, "data", "scan-results.json");
  const scannerDataFile = path.join(projectRoot, "scanner", "data", "scan-results.json");

  console.log("\n===============================");
  console.log(`🔍 PATH VALIDATOR (${context})`);
  console.log("===============================\n");

  console.log("process.cwd():");
  console.log("  ", cwd, "\n");

  console.log("Expected shared data file:");
  console.log("  ", expectedDataFile);
  console.log("  Exists:", fs.existsSync(expectedDataFile), "\n");

  console.log("UI data file (wrong location):");
  console.log("  ", uiDataFile);
  console.log("  Exists:", fs.existsSync(uiDataFile), "\n");

  console.log("Scanner data file (wrong location):");
  console.log("  ", scannerDataFile);
  console.log("  Exists:", fs.existsSync(scannerDataFile), "\n");

  console.log("================================\n");
}
