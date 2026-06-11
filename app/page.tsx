async function getDevices() {
  const res = await fetch(`${process.env.NEXT_PUBLIC_BASE_URL}/api/devices`, {
    cache: "no-store"
  });
  return res.json();
}

export default async function Home() {
  const devices = await getDevices();

  return (
    <main style={{ padding: "2rem", fontFamily: "system-ui, sans-serif" }}>
      <h1 style={{ fontSize: "2.5rem", marginBottom: "1rem" }}>
        NGPCX — Device Compatibility
      </h1>

      <ul style={{ listStyle: "none", padding: 0 }}>
        {devices.map((d: any) => (
          <li
            key={d.id}
            style={{
              padding: "1rem",
              marginBottom: "1rem",
              border: "1px solid #ddd",
              borderRadius: "8px"
            }}
          >
            <h2 style={{ margin: 0 }}>{d.brand} {d.model}</h2>
            <p style={{ margin: "0.5rem 0" }}>
              CPU: {d.cpu} • GPU: {d.gpu} • RAM: {d.ram}
            </p>
            <strong>
              {d.compatibility.nextGenReady
                ? "✅ Next‑Gen Ready"
                : "❌ Not Compatible"}
            </strong>
            <p style={{ opacity: 0.7 }}>{d.compatibility.notes}</p>
          </li>
        ))}
      </ul>
    </main>
  );
}
