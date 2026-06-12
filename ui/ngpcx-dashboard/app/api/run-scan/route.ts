import { NextResponse } from "next/server";
import { exec } from "child_process";
import path from "path";
import fs from "fs";
import { validatePaths } from "utils/pathValidator";
import { SCAN_RESULTS_FILE } from "utils/paths";

export async function POST() {
  validatePaths("API /run-scan");

  const scannerPath = path.join(process.cwd(), "..", "..", "scanner", "run.ts");
  const scannerTsconfig = path.join(
    process.cwd(),
    "..",
    "..",
    "scanner",
    "tsconfig.scanner.json"
  );

  return new Promise((resolve) => {
    exec(
      `npx ts-node --project "${scannerTsconfig}" "${scannerPath}"`,
      (error) => {
        if (error) {
          console.error("Scanner error:", error);
          return resolve(
            NextResponse.json({ error: "Scan failed" }, { status: 500 })
          );
        }

        if (fs.existsSync(SCAN_RESULTS_FILE)) {
          const json = JSON.parse(fs.readFileSync(SCAN_RESULTS_FILE, "utf8"));
          json.lastScanned = new Date().toISOString();
          fs.writeFileSync(SCAN_RESULTS_FILE, JSON.stringify(json, null, 2));
        }

        resolve(NextResponse.json({ ok: true }));
      }
    );
  });
}
