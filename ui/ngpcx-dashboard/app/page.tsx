"use client";

import fs from "fs";
import path from "path";
import { useState } from "react";

// ----------------------
// Logo Component
// ----------------------
function Logo() {
  return (
    <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-blue-600 to-blue-400 flex items-center justify-center text-white font-bold shadow">
      N
    </div>
  );
}

// ----------------------
// Dark Mode Toggle
// ----------------------
function DarkModeToggle() {
  return (
    <button
      onClick={() => document.documentElement.classList.toggle("dark")}
      className="px-3 py-1 rounded-lg border bg-gray-100 dark:bg-gray-800 dark:text-gray-200"
    >
      Toggle Dark
    </button>
  );
}

// ----------------------
// Readiness Gauge
// ----------------------
function ReadinessGauge({ score }: { score: number }) {
  const radius = 45;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (score / 100) * circumference;

  return (
    <div className="flex flex-col items-center">
      <svg width="120" height="120">
        <circle
          cx="60"
          cy="60"
          r={radius}
          stroke="#e5e7eb"
          strokeWidth="10"
          fill="none"
        />
        <circle
          cx="60"
          cy="60"
          r={radius}
          stroke="#3b82f6"
          strokeWidth="10"
          fill="none"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
          transform="rotate(-90 60 60)"
        />
      </svg>
      <div className="text-3xl font-bold mt-2">{score}</div>
      <div className="text-gray-500 text-sm">Readiness Score</div>
    </div>
  );
}

// ----------------------
// Per-App Detail Drawer
// ----------------------
function AppDetails({ app, onClose }: any) {
  if (!app) return null;

  return (
    <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex justify-end z-50">
      <div className="w-96 bg-white dark:bg-gray-900 p-6 shadow-xl h-full overflow-y-auto">
        <button
          className="mb-4 text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
          onClick={onClose}
        >
          Close
        </button>

        <h2 className="text-2xl font-bold mb-4">{app.name}</h2>

        <div className="space-y-3 text-sm">
          <p><strong>Executable:</strong> {app.exePath ?? "N/A"}</p>
          <p><strong>Architecture:</strong> {app.arch}</p>
          <p><strong>Support Level:</strong> {app.supportLevel}</p>

          {app.matchedEntry && (
            <>
              <p><strong>Publisher:</strong> {app.matchedEntry.publisher}</p>
              <p><strong>Categories:</strong> {app.matchedEntry.categories?.join(", ")}</p>
              <p><strong>Verification:</strong> {app.matchedEntry.verification?.source}</p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ----------------------
// Main Dashboard Page
// ----------------------
export default function Dashboard() {
  const filePath = path.join(process.cwd(), "data", "scan-results.json");
  let results: any = null;

  try {
    const json = fs.readFileSync(filePath, "utf8");
    results = JSON.parse(json);
  } catch (err) {
    console.error("Failed to load scan-results.json:", err);
  }

  if (!results) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-gray-50 to-gray-200 p-10">
        <div className="max-w-5xl mx-auto">
          <h1 className="text-4xl font-bold tracking-tight">NGPCX Dashboard</h1>
          <p className="mt-4 text-red-600 text-lg">
            No scan results found. Run the scanner to generate scan-results.json.
          </p>
        </div>
      </div>
    );
  }

  const native = results.native ?? [];
  const emulated = results.emulated ?? [];
  const unsupported = results.unsupported ?? [];

  const apps = [
    ...native.map((a: any) => ({ ...a, supportLevel: "native" })),
    ...emulated.map((a: any) => ({ ...a, supportLevel: "emulated" })),
    ...unsupported.map((a: any) => ({ ...a, supportLevel: "unsupported" })),
  ];

  const readinessScore = Math.round((native.length / apps.length) * 100);

  const supportColors: Record<string, string> = {
    native: "bg-green-600",
    emulated: "bg-yellow-600",
    unsupported: "bg-red-600",
  };

  const [selectedApp, setSelectedApp] = useState(null);

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950 text-gray-900 dark:text-gray-100">

      {/* Navigation */}
      <header className="flex items-center justify-between px-6 py-4 border-b bg-white/70 dark:bg-gray-900/70 backdrop-blur">
        <div className="flex items-center gap-3">
          <Logo />
          <span className="text-xl font-semibold">NGPCX</span>
        </div>
        <DarkModeToggle />
      </header>

      {/* Main Content */}
      <main className="p-10 max-w-6xl mx-auto space-y-10">

        {/* Header */}
        <div className="flex items-center justify-between">
          <h1 className="text-4xl font-bold tracking-tight">ARM Readiness Dashboard</h1>
          <ReadinessGauge score={readinessScore} />
        </div>

        {/* Summary Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
          {[
            { label: "Native Apps", value: native.length },
            { label: "Emulated Apps", value: emulated.length },
            { label: "Unsupported Apps", value: unsupported.length },
          ].map((card, i) => (
            <div
              key={i}
              className="rounded-2xl border backdrop-blur bg-white/60 dark:bg-gray-900/60 shadow-sm p-6"
            >
              <h2 className="text-gray-500 dark:text-gray-400 text-sm font-medium">{card.label}</h2>
              <p className="text-4xl font-bold mt-2">{card.value}</p>
            </div>
          ))}
        </div>

        {/* Table */}
        <div className="rounded-2xl border shadow-sm overflow-hidden bg-white/70 dark:bg-gray-900/70 backdrop-blur">
          <table className="w-full text-left">
            <thead className="bg-gray-100 dark:bg-gray-800 border-b">
              <tr>
                <th className="p-4 text-sm font-semibold text-gray-600 dark:text-gray-300">Name</th>
                <th className="p-4 text-sm font-semibold text-gray-600 dark:text-gray-300">Executable</th>
                <th className="p-4 text-sm font-semibold text-gray-600 dark:text-gray-300">Arch</th>
                <th className="p-4 text-sm font-semibold text-gray-600 dark:text-gray-300">ARM Support</th>
              </tr>
            </thead>
            <tbody>
              {apps.map((app: any, i: number) => (
                <tr
                  key={i}
                  onClick={() => setSelectedApp(app)}
                  className={`cursor-pointer border-b last:border-0 ${
                    i % 2 === 0
                      ? "bg-white/40 dark:bg-gray-800/40"
                      : "bg-white/20 dark:bg-gray-800/20"
                  } hover:bg-white/60 dark:hover:bg-gray-700/60 transition`}
                >
                  <td className="p-4 font-medium">{app.name}</td>
                  <td className="p-4 text-gray-500">{app.exePath ?? "N/A"}</td>
                  <td className="p-4">{app.arch}</td>
                  <td className="p-4">
                    <span
                      className={`px-3 py-1 rounded-full text-white text-sm font-medium ${supportColors[app.supportLevel]}`}
                    >
                      {app.supportLevel}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Detail Drawer */}
        <AppDetails app={selectedApp} onClose={() => setSelectedApp(null)} />

      </main>
    </div>
  );
}
