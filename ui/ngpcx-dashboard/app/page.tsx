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
      <div className="p-8">
        <h1 className="text-3xl font-bold">NGPCX Dashboard</h1>
        <p className="mt-4 text-red-600">
          No scan results found. Run the scanner to generate scan-results.json.
        </p>
      </div>
    );
  }

  // Your JSON structure:
  // { native: [...], emulated: [...], unsupported: [...] }
  const native = results.native ?? [];
  const emulated = results.emulated ?? [];
  const unsupported = results.unsupported ?? [];

  // Merge into one list with a supportLevel field
  const apps = [
    ...native.map((a: any) => ({ ...a, supportLevel: "native" })),
    ...emulated.map((a: any) => ({ ...a, supportLevel: "emulated" })),
    ...unsupported.map((a: any) => ({ ...a, supportLevel: "unsupported" })),
  ];

  return (
    <div className="p-8 space-y-6">
      <h1 className="text-3xl font-bold">NGPCX Readiness Dashboard</h1>

      <div className="text-xl">
        <span className="font-semibold">Total Apps:</span>{" "}
        <span className="text-blue-600">{apps.length}</span>
      </div>

      <div className="border rounded-lg overflow-hidden">
        <table className="w-full text-left">
          <thead className="bg-gray-100">
            <tr>
              <th className="p-3">Name</th>
              <th className="p-3">Executable</th>
              <th className="p-3">Arch</th>
              <th className="p-3">ARM Support</th>
            </tr>
          </thead>
          <tbody>
            {apps.map((app: any, i: number) => (
              <tr key={i} className="border-t">
                <td className="p-3">{app.name}</td>
                <td className="p-3 text-gray-600">{app.exePath ?? "N/A"}</td>
                <td className="p-3">{app.arch}</td>
                <td className="p-3">
                  <span
                    className={
                      "px-2 py-1 rounded text-white " +
                      (app.supportLevel === "native"
                        ? "bg-green-600"
                        : app.supportLevel === "emulated"
                        ? "bg-yellow-600"
                        : "bg-red-600")
                    }
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
