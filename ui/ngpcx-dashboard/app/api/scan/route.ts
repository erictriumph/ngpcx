import { NextResponse } from "next/server";
import fs from "fs";
import { validatePaths } from "utils/pathValidator";
import { SCAN_RESULTS_FILE } from "utils/paths";

export async function GET() {
  validatePaths("API /scan");

  try {
    if (!fs.existsSync(SCAN_RESULTS_FILE)) {
      return NextResponse.json({
        native: [],
        emulated: [],
        unsupported: [],
        lastScanned: null
      });
    }

    const json = fs.readFileSync(SCAN_RESULTS_FILE, "utf8");
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
