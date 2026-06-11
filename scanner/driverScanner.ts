// /scanner/driverScanner.ts

import { InstalledApp } from "./localScanner";
import { execSync } from "child_process";

export function enrichWithDrivers(apps: InstalledApp[]) {
  let output = "";

  try {
    output = execSync(
      `powershell -Command "Get-WmiObject Win32_SystemDriver | Select-Object Name,DisplayName,State,PathName"`,
      { encoding: "utf8" }
    );
  } catch {
    return;
  }

  const lines = output.split("\n").slice(2);

  const drivers: { name: string; path: string }[] = [];

  for (const line of lines) {
    const parts = line.trim().split(/\s{2,}/);
    if (parts.length < 2) continue;

    const name = parts[0];
    const path = parts[parts.length - 1];

    drivers.push({ name, path });
  }

  for (const app of apps) {
    const lower = app.name.toLowerCase();
    const matched = drivers
      .filter(d => d.path && d.path.toLowerCase().includes(lower))
      .map(d => d.name);

    if (matched.length > 0) {
      app.drivers = matched;
    }
  }
}
