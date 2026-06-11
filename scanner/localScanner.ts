// /scanner/localScanner.ts

import os from "os";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { ScraperResult } from "../scrapers/BaseScraper";
import { renderStage, endStage } from "./progress";
import {
  loadExeIndex,
  buildExeIndex,
  ExeIndex
} from "./exeIndexer";

const DB_PATH = path.join(process.cwd(), "data", "compatibility.json");
const CONCURRENCY = 4;

export interface InstalledApp {
  name: string;
  exePath: string | null;
  arch: "x86" | "x64" | "arm64" | "unknown";
  matchedEntry?: ScraperResult;
  storeArch?: "arm64" | "x64" | "x86" | "unknown";
  drivers?: string[];
  appScore?: number;
}

//
// ─────────────────────────────────────────────────────────────
//   EXE INDEX LOADING
// ─────────────────────────────────────────────────────────────
//

let exeIndex: ExeIndex | null = null;

export function ensureExeIndex(force = false) {
  if (force) {
    exeIndex = buildExeIndex();
    return;
  }

  exeIndex = loadExeIndex();
  if (!exeIndex) exeIndex = buildExeIndex();
}

function findExeForApp(appName: string): string | null {
  if (!exeIndex) return null;

  const lower = appName.toLowerCase();

  // Try exact exe name match
  for (const exeName of Object.keys(exeIndex)) {
    if (exeName.includes(lower)) {
      return exeIndex[exeName][0];
    }
  }

  // Try fuzzy match (Chrome → chrome.exe)
  for (const exeName of Object.keys(exeIndex)) {
    const base = exeName.replace(".exe", "");
    if (lower.includes(base)) {
      return exeIndex[exeName][0];
    }
  }

  return null;
}

//
// ─────────────────────────────────────────────────────────────
//   INSTALLED APPS ENUMERATION
// ─────────────────────────────────────────────────────────────
//

function getInstalledApps(): InstalledApp[] {
  let output = "";

  try {
    output = execSync("winget list --source winget", {
      encoding: "utf8"
    });
  } catch (err) {
    console.error("Failed to run winget list:", err);
    return [];
  }

  const lines = output.split("\n").slice(2);
  const apps: InstalledApp[] = [];

  for (const line of lines) {
    const parts = line.trim().split(/\s{2,}/);
    if (parts.length < 2) continue;

    const name = parts[0];
    apps.push({
      name,
      exePath: null,
      arch: "unknown"
    });
  }

  return apps;
}

//
// ─────────────────────────────────────────────────────────────
//   ARCHITECTURE DETECTION
// ─────────────────────────────────────────────────────────────
//

function detectBinaryArchitecture(filePath: string): "x86" | "x64" | "arm64" | "unknown" {
  try {
    const fd = fs.openSync(filePath, "r");
    const buffer = Buffer.alloc(6);

    fs.readSync(fd, buffer, 0, 6, 0x3C);
    const peOffset = buffer.readUInt32LE(0);

    const machineBuffer = Buffer.alloc(2);
    fs.readSync(fd, machineBuffer, 0, 2, peOffset + 4);
    const machine = machineBuffer.readUInt16LE(0);

    fs.closeSync(fd);

    switch (machine) {
      case 0x014c: return "x86";
      case 0x8664: return "x64";
      case 0xAA64: return "arm64";
      default: return "unknown";
    }
  } catch {
    return "unknown";
  }
}

//
// ─────────────────────────────────────────────────────────────
//   COMPATIBILITY DB
// ─────────────────────────────────────────────────────────────
//

function loadCompatibilityDB(): ScraperResult[] {
  if (!fs.existsSync(DB_PATH)) return [];
  return JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
}

function matchAppToDB(app: InstalledApp, db: ScraperResult[]): ScraperResult | undefined {
  const lowerName = app.name.toLowerCase();
  const exeName = app.exePath ? path.basename(app.exePath).toLowerCase() : null;

  for (const entry of db) {
    const entryName = entry.name?.toLowerCase() ?? "";
    const entryId = entry.id?.toLowerCase() ?? "";

    //
    // 1. EXE name match (highest confidence)
    //
    if (exeName && entry.exeNames?.some(e => e.toLowerCase() === exeName)) {
      return entry;
    }

    //
    // 2. matchNames[] fuzzy match
    //
    if (entry.matchNames?.some(m => lowerName.includes(m.toLowerCase()))) {
      return entry;
    }

    //
    // 3. Winget / package ID match
    //
    if (entryId && (lowerName.includes(entryId) || entryId.includes(lowerName))) {
      return entry;
    }

    //
    // 4. Name similarity fallback
    //
    if (
      entryName &&
      (lowerName.includes(entryName) || entryName.includes(lowerName))
    ) {
      return entry;
    }
  }

  return undefined;
}


//
// ─────────────────────────────────────────────────────────────
//   PER‑APP PROCESSING
// ─────────────────────────────────────────────────────────────
//

async function processApp(app: InstalledApp, db: ScraperResult[]) {
  const exe = findExeForApp(app.name);
  if (exe) {
    app.exePath = exe;
    app.arch = detectBinaryArchitecture(exe);
  }

  app.matchedEntry = matchAppToDB(app, db);
}

//
// ─────────────────────────────────────────────────────────────
//   MAIN SCANNER
// ─────────────────────────────────────────────────────────────
//

export async function runLocalScanner() {
  console.log("=== NGPCX Local Scanner (x86-hosted ARM readiness) ===");

  if (os.platform() !== "win32") {
    console.log("Local scanner requires Windows. Skipping.");
    return [];
  }

  //
  // Load or build EXE index
  //
  ensureExeIndex(process.argv.includes("--force"));

  //
  // Enumerate installed apps
  //
  renderStage("Enumerating installed apps", 0, 1);
  const installed = getInstalledApps();
  renderStage("Enumerating installed apps", 1, 1, `${installed.length} apps`);
  endStage();

  //
  // Load compatibility DB
  //
  const db = loadCompatibilityDB();
  console.log(`Loaded ${db.length} ARM compatibility entries`);

  //
  // Parallel scanning
  //
  const total = installed.length;
  let index = 0;

  const queue = [...installed];
  const workers: Promise<void>[] = [];

  for (let i = 0; i < CONCURRENCY; i++) {
    const worker = (async () => {
      while (queue.length > 0) {
        const app = queue.shift();
        if (!app) break;

        index++;
        renderStage("Scanning apps", index, total, app.name);

        await processApp(app, db);
      }
    })();

    workers.push(worker);
  }

  await Promise.all(workers);
  endStage();

  return installed;
}
