import { NextResponse } from "next/server";
import { exec } from "child_process";
import path from "path";

export async function POST() {
  return new Promise((resolve) => {
    // Resolve repo root from the dashboard folder
    const repoRoot = path.resolve(process.cwd(), "../..");

    // Absolute path to scanner/run.ts
    const scannerPath = path.join(repoRoot, "scanner", "run.ts");

    console.log("Running scanner:", scannerPath);

    // Use ts-node to execute TypeScript directly
    exec(`npx ts-node --project tsconfig.scanner.json "${scannerPath}"`, (error, stdout, stderr) => {

      console.log(stdout);
      console.error(stderr);

      if (error) {
        console.error("Scanner failed:", error);
        resolve(
          NextResponse.json(
            { ok: false, error: "Scanner failed" },
            { status: 500 }
          )
        );
        return;
      }

      resolve(NextResponse.json({ ok: true }));
    });
  });
}
