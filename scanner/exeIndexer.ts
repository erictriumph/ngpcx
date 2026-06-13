// /scanner/exeIndexer.ts

import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { PROJECT_ROOT } from "utils/paths";

const CACHE_DIR = path.join(PROJECT_ROOT, ".cache");
const INDEX_PATH = path.join(CACHE_DIR, "exeIndex.json");

const SKIP_DIRS = [
  "WindowsApps",
  "ProgramData",
  "AppData\\Local\\Packages",
  "AppData\\Local\\Microsoft\\WindowsApps",
  "AppData\\Local\\Temp"
];

export interface ExeIndex {
  [exeName: string]: string[];
}

function shouldSkip(fullPath: string): boolean {
  return SKIP_DIRS.some(skip => fullPath.includes(skip));
}

export function loadExeIndex(): ExeIndex | null {
  if (!fs.existsSync(INDEX_PATH)) return null;

  try {
    return JSON.parse(fs.readFileSync(INDEX_PATH, "utf8"));
  } catch {
    return null;
  }
}

export function saveExeIndex(index: ExeIndex) {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR);
  }

  fs.writeFileSync(INDEX_PATH, JSON.stringify(index, null, 2), "utf8");
}

export function buildExeIndex(): ExeIndex {
  console.log("Building EXE index (first run)…");

  const roots = [
    process.env["ProgramFiles"],
    process.env["ProgramFiles(x86)"],
    process.env["LocalAppData"]
  ].filter(Boolean) as string[];

  const index: ExeIndex = {};

  for (const root of roots) {
    try {
      const output = execSync(
        `powershell -Command "Get-ChildItem -Recurse -Force -ErrorAction SilentlyContinue -Filter *.exe -Path '${root}' | Select-Object FullName"`,
        { encoding: "utf8" }
      );

      const lines = output.split("\n").slice(2);

      for (const line of lines) {
        const exePath = line.trim();
        if (!exePath || shouldSkip(exePath)) continue;

        const exeName = path.basename(exePath).toLowerCase();

        if (!index[exeName]) index[exeName] = [];
        index[exeName].push(exePath);
      }
    } catch {
      continue;
    }
  }

  saveExeIndex(index);
  console.log(`EXE index built: ${Object.keys(index).length} unique executables`);

  return index;
}
