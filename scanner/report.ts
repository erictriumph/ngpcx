// /scanner/report.ts

import { InstalledApp } from "./localScanner";

export interface ReadinessReport {
  native: InstalledApp[];
  emulated: InstalledApp[];
  x86only: InstalledApp[];
  incompatible: InstalledApp[];
  unknown: InstalledApp[];
  score: number;
}

export function generateReadinessReport(apps: InstalledApp[]): ReadinessReport {
  const native: InstalledApp[] = [];
  const emulated: InstalledApp[] = [];
  const x86only: InstalledApp[] = [];
  const incompatible: InstalledApp[] = [];
  const unknown: InstalledApp[] = [];

  for (const app of apps) {
    const entry = app.matchedEntry;

    if (!entry) {
      unknown.push(app);
      continue;
    }

    const level = entry.armSupportLevel ?? "unknown";

    switch (level) {
      case "native":
        native.push(app);
        break;
      case "x64-emulated":
        emulated.push(app);
        break;
      case "x86-emulated":
        x86only.push(app);
        break;
      case "unsupported":
        incompatible.push(app);
        break;
      default:
        unknown.push(app);
    }
  }

  const totalKnown = native.length + emulated.length + x86only.length + incompatible.length;

  const score =
    totalKnown === 0
      ? 0
      : Math.max(
          0,
          Math.min(
            100,
            Math.round(
              (native.length * 4 +
                emulated.length * 3 +
                x86only.length * 2 -
                incompatible.length * 5) /
                (totalKnown * 4) *
                100
            )
          )
        );

  return {
    native,
    emulated,
    x86only,
    incompatible,
    unknown,
    score
  };
}

export function printReadinessReport(report: ReadinessReport) {
  console.log("\n=== ARM Readiness Report ===");
  console.log(`ARM Readiness Score: ${report.score}/100\n`);

  console.log("Native ARM64 available:");
  report.native.forEach(a => console.log(" -", a.name));

  console.log("\nRuns under x64 emulation:");
  report.emulated.forEach(a => console.log(" -", a.name));

  console.log("\nx86-only (slowest):");
  report.x86only.forEach(a => console.log(" -", a.name));

  console.log("\nKnown incompatible:");
  report.incompatible.forEach(a => console.log(" -", a.name));

  console.log("\nUnknown / not in database:");
  report.unknown.forEach(a => console.log(" -", a.name));
}
