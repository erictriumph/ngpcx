import { NextResponse } from "next/server";
import path from "path";
import fs from "fs";

export async function GET() {
  try {
    const filePath = path.join(process.cwd(), "data", "scan-results.json");

    if (!fs.existsSync(filePath)) {
      return NextResponse.json({
        native: [],
        emulated: [],
        unsupported: [],
        lastScanned: null,
      });
    }

    const json = fs.readFileSync(filePath, "utf8");
    const data = JSON.parse(json);

    return NextResponse.json({
      native: data.native ?? [],
      emulated: data.emulated ?? [],
      unsupported: data.unsupported ?? [],
      lastScanned: data.lastScanned ?? null,
    });
  } catch {
    return NextResponse.json({
      native: [],
      emulated: [],
      unsupported: [],
      lastScanned: null,
    });
  }
}
