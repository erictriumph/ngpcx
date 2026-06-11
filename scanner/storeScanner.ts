// /scanner/storeScanner.ts

import { InstalledApp } from "./localScanner";
import { execSync } from "child_process";

export function enrichWithStoreArch(apps: InstalledApp[]) {
  let output = "";

  try {
    output = execSync(
      `powershell -Command "Get-AppxPackage | Select-Object Name,Architecture"`,
      { encoding: "utf8" }
    );
  } catch {
    return;
  }

  const lines = output.split("\n").slice(2);

  const map = new Map<string, string>();

  for (const line of lines) {
    const parts = line.trim().split(/\s{2,}/);
    if (parts.length < 2) continue;

    const name = parts[0];
    const arch = parts[1].toLowerCase();

    map.set(name.toLowerCase(), arch);
  }

  for (const app of apps) {
    const key = app.name.toLowerCase();
    for (const [pkg, arch] of map.entries()) {
      if (key.includes(pkg) || pkg.includes(key)) {
        if (arch.includes("arm")) app.storeArch = "arm64";
        else if (arch.includes("x64")) app.storeArch = "x64";
        else if (arch.includes("x86")) app.storeArch = "x86";
        else app.storeArch = "unknown";
        break;
      }
    }
  }
}
