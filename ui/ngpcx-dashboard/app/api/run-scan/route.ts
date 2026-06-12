import { NextResponse } from "next/server";
import { exec } from "child_process";
import path from "path";
import fs from "fs";
import { validatePaths } from "utils/pathValidator";

export async function POST() {
  validatePaths("API /run-scan");

  // Absolute paths to scanner entry + scanner tsconfig
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

        const filePath = path.join(process.cwd(), "..", "data", "scan-results.json");

        if (fs.existsSync(filePath)) {
          const json = JSON.parse(fs.readFileSync(filePath, "utf8"));
          json.lastScanned = new Date().toISOString();
          fs.writeFileSync(filePath, JSON.stringify(json, null, 2));
        }

        resolve(NextResponse.json({ ok: true }));
      }
    );
  });
}
