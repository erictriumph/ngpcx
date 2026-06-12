"use client";

import { useEffect, useState } from "react";
import ScanProgress from "./components/ScanProgress";
import Toast from "./components/Toast";

function timeAgo(iso: string | null) {
  if (!iso) return "Never";
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return "Just now";
  if (diff < 3600) return `${Math.floor(diff / 60)} minutes ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} hours ago`;
  return `${Math.floor(diff / 86400)} days ago`;
}

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
// Animated Gauge
// ----------------------
function ReadinessGauge({ score }: { score: number }) {
  const [animatedScore, setAnimatedScore] = useState(0);

  useEffect(() => {
    const duration = 600;
    const start = performance.now();

    function animate(now: number) {
      const progress = Math.min((now - start) / duration, 1);
      setAnimatedScore(Math.round(progress * score));
      if (progress < 1) requestAnimationFrame(animate);
    }

    requestAnimationFrame(animate);
  }, [score]);

  const radius = 45;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (animatedScore / 100) * circumference;

  return (
    <div className="flex flex-col items-center transition-all">
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
          className="transition-all duration-300"
        />
      </svg>
      <div className="text-3xl font-bold mt-2">{animatedScore}</div>
      <div className="text-gray-500 text-sm">Readiness Score</div>
    </div>
  );
}

// ----------------------
// Drawer Component
// ----------------------
function AppDetails({ app, onClose }: any) {
  if (!app) return null;

  return (
    <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex justify-end z-50 animate-fadeIn">
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
  const [results, setResults] = useState<any>(null);
  const [selectedApp, setSelectedApp] = useState(null);
  const [scanning, setScanning] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  async function loadResults() {
    const res = await fetch("/api/scan");
    const data = await res.json();
    setResults(data);
  }

  useEffect(() => {
    loadResults();
  }, []);

  async function runScan() {
    setScanning(true);
    await fetch("/api/run-scan", { method: "POST" });
    await loadResults();
    setScanning(false);
    setToast("Scan complete!");
  }

  if (!results) {
    return (
      <div className="p-10 text-gray-600 dark:text-gray-300">Loading scan results…</div>
    );
  }

  const native = results.native ?? [];
  const emulated = results.emulated ?? [];
  const unsupported = results.unsupported ?? [];

  const noScanYet =
    native.length === 0 &&
    emulated.length === 0 &&
    unsupported.length === 0;

  if (noScanYet) {
    return (
      <div className="p-10 space-y-6">
        <h1 className="text-3xl font-bold">ARM Readiness Dashboard</h1>
        <p className="text-lg">
          No scan results found. Press <strong>Run Scan</strong> to perform your first scan.
        </p>

        <button
          onClick={runScan}
          className="px-4 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700 transition"
        >
          Run Scan
        </button>

        {scanning && <ScanProgress scanning={scanning} />}
        {toast && <Toast message={toast} onClose={() => setToast(null)} />}
      </div>
    );
  }

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

  return (
    <div className="p-10 space-y-10">

      {scanning && <ScanProgress scanning={scanning} />}
      {toast && <Toast message={toast} onClose={() => setToast(null)} />}

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-4xl font-bold tracking-tight">ARM Readiness Dashboard</h1>
          <p className="text-gray-500 dark:text-gray-400 mt-1">
            Last scanned: {timeAgo(results.lastScanned)}
          </p>
        </div>

        <button
          onClick={runScan}
          className="px-4 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700 transition"
        >
          Run Scan
        </button>
      </div>

      {/* Gauge */}
      <div className="flex justify-end">
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
            className="rounded-2xl border backdrop-blur bg-white/60 dark:bg-gray-900/60 shadow-sm p-6 transition-all hover:scale-[1.02]"
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
                className={`cursor-pointer border-b last:border-0 transition-all hover:scale-[1.01] ${
                  i % 2 === 0
                    ? "bg-white/40 dark:bg-gray-800/40"
                    : "bg-white/20 dark:bg-gray-800/20"
                } hover:bg-white/60 dark:hover:bg-gray-700/60`}
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

      <AppDetails app={selectedApp} onClose={() => setSelectedApp(null)} />
    </div>
  );
}
