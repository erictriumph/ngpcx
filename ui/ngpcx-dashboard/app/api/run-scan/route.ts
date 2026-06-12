import { NextResponse } from "next/server";
import { exec } from "child_process";
import path from "path";

export async function POST() {
  const scannerPath = path.join(process.cwd(), "..", "..", "scanner", "run.ts");

  return new Promise((resolve) => {
    exec(
      `npx ts-node --project tsconfig.scanner.json "${scannerPath}"`,
      (error, stdout, stderr) => {
        if (error) {
          console.error("Scanner failed:", stderr);
          resolve(
            NextResponse.json({ error: "Scan failed" }, { status: 500 })
          );
          return;
        }

        resolve(NextResponse.json({ ok: true }));
      }
    );
  });
}
