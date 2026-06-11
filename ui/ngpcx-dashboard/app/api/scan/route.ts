import fs from "fs";
import path from "path";
import { NextResponse } from "next/server";

export async function GET() {
  const filePath = path.join(process.cwd(), "..", "..", "data", "scan-results.json");

  try {
    const json = fs.readFileSync(filePath, "utf8");
    const data = JSON.parse(json);
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json({ error: "Failed to load scan results" }, { status: 500 });
  }
}
