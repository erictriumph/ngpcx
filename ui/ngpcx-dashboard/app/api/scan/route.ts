import { NextResponse } from "next/server";
import path from "path";
import fs from "fs";

export async function GET() {
  try {
    const filePath = path.join(process.cwd(), "..", "..", "data", "scan-results.json");

    const json = fs.readFileSync(filePath, "utf8");
    const data = JSON.parse(json);

    return NextResponse.json(data);
  } catch (err) {
    console.error("Failed to load scan results:", err);
    return NextResponse.json({ error: "Failed to load scan results" }, { status: 500 });
  }
}
