import { NextResponse } from "next/server";
import { exec } from "child_process";
import path from "path";

export async function GET() {
  return new Promise((resolve) => {
    // Path to compiled JS scanner
    const scannerJsPath = path.join(
      process.cwd(),
      "..",
      "..",
      "scanner",
      "dist",
      "run.js"
    );

    console.log("Running scanner:", scannerJsPath);

    exec(`node "${scannerJsPath}"`, (error, stdout, stderr) => {
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
