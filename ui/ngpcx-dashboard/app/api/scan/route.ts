import { NextResponse } from "next/server";
import path from "path";
import fs from "fs";
import { validatePaths } from "utils/pathValidator";

export async function GET() {
  validatePaths("API /scan");

  try {
    const filePath = path.join(process.cwd(), "..", "data", "scan-results.json");

    if (!fs.existsSync(filePath)) {
      return NextResponse.json({
        native: [],
        emulated: [],
        unsupported: [],
        lastScanned: null
      });
    }

    const json = fs.readFileSync(filePath, "utf8");
    const data = JSON.parse(json);

    return NextResponse.json({
      native: data.native ?? [],
      emulated: data.emulated ?? [],
      unsupported: data.unsupported ?? [],
      lastScanned: data.lastScanned ?? null
    });
  } catch (err) {
    console.error("Error reading scan results:", err);
    return NextResponse.json({
      native: [],
      emulated: [],
      unsupported: [],
      lastScanned: null
    });
  }
}
