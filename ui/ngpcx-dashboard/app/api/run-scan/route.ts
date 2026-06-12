import { NextResponse } from "next/server";
import { exec } from "child_process";
import path from "path";
import fs from "fs";

export async function POST() {
  const scannerPath = path.join(process.cwd(), "..", "..", "scanner", "run.ts");

  return new Promise((resolve) => {
    exec(
      `npx ts-node --project tsconfig.scanner.json "${scannerPath}"`,
      (error) => {
        if (error) {
          return resolve(
            NextResponse.json({ error: "Scan failed" }, { status: 500 })
          );
        }

        // Write timestamp
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
