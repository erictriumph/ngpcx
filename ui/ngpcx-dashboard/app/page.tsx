import fs from "fs";
import path from "path";

export default function Dashboard() {
  // Load scan-results.json from /data
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

  const { readinessScore, apps } = results;

  return (
    <div className="p-8 space-y-6">
      <h1 className="text-3xl font-bold">NGPCX Readiness Dashboard</h1>

      <div className="text-xl">
        <span className="font-semibold">Readiness Score:</span>{" "}
        <span className="text-blue-600">{readinessScore}/100</span>
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
            {apps.map((app: any) => (
              <tr key={app.exePath} className="border-t">
                <td className="p-3">{app.name}</td>
                <td className="p-3 text-gray-600">{app.exePath}</td>
                <td className="p-3">{app.arch}</td>
                <td className="p-3">
                  <span
                    className={
                      "px-2 py-1 rounded text-white " +
                      (app.match?.armSupportLevel === "native"
                        ? "bg-green-600"
                        : app.match?.armSupportLevel === "emulated"
                        ? "bg-yellow-600"
                        : "bg-red-600")
                    }
                  >
                    {app.match?.armSupportLevel ?? "unknown"}
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
