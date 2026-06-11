import { NextResponse } from "next/server";
import { exec } from "child_process";
import path from "path";

export async function POST() {
  return new Promise((resolve) => {
    // Next.js app root = /ui/ngpcx-dashboard
    // Scanner is at: /scanner/run.ts (two levels up)
    const scannerPath = path.join(
      process.cwd(),
      "..",
      "..",
      "scanner",
      "run.ts"
    );

    console.log("Running scanner at:", scannerPath);

    exec(`node ${scannerPath}`, (error, stdout, stderr) => {
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
