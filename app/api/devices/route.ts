import { NextResponse } from "next/server";
import devices from "@/data/devices.json";

export async function GET() {
  return NextResponse.json(devices);
}
