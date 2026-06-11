import fs from "fs";
import path from "path";

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
      <div className="p-10">
        <h1 className="text-4xl font-bold tracking-tight">NGPCX Dashboard</h1>
        <p className="mt-4 text-red-600 text-lg">
          No scan results found. Run the scanner to generate scan-results.json.
        </p>
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

  const supportColors: Record<string, string> = {
    native: "bg-green-600",
    emulated: "bg-yellow-600",
    unsupported: "bg-red-600",
  };

  return (
    <div className="p-10 space-y-10">
      {/* Header */}
      <div>
        <h1 className="text-4xl font-bold tracking-tight">NGPCX Readiness Dashboard</h1>
        <p className="text-gray-500 mt-2 text-lg">
          A quick view of your system’s ARM compatibility and app readiness.
        </p>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
        <div className="rounded-xl border p-6 shadow-sm bg-white">
          <h2 className="text-gray-500 text-sm font-medium">Native Apps</h2>
          <p className="text-3xl font-bold mt-2">{native.length}</p>
        </div>

        <div className="rounded-xl border p-6 shadow-sm bg-white">
          <h2 className="text-gray-500 text-sm font-medium">Emulated Apps</h2>
          <p className="text-3xl font-bold mt-2">{emulated.length}</p>
        </div>

        <div className="rounded-xl border p-6 shadow-sm bg-white">
          <h2 className="text-gray-500 text-sm font-medium">Unsupported Apps</h2>
          <p className="text-3xl font-bold mt-2">{unsupported.length}</p>
        </div>
      </div>

      {/* App Table */}
      <div className="rounded-xl border shadow-sm overflow-hidden bg-white">
        <table className="w-full text-left">
          <thead className="bg-gray-50 border-b">
            <tr>
              <th className="p-4 text-sm font-semibold text-gray-600">Name</th>
              <th className="p-4 text-sm font-semibold text-gray-600">Executable</th>
              <th className="p-4 text-sm font-semibold text-gray-600">Arch</th>
              <th className="p-4 text-sm font-semibold text-gray-600">ARM Support</th>
            </tr>
          </thead>
          <tbody>
            {apps.map((app: any, i: number) => (
              <tr key={i} className="border-b last:border-0 hover:bg-gray-50 transition">
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
    </div>
  );
}
