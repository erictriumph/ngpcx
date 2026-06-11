async function getDevices() {
  const res = await fetch(`${process.env.NEXT_PUBLIC_BASE_URL}/api/devices`, {
    cache: "no-store"
  });

  if (!res.ok) {
    throw new Error("Failed to fetch devices");
  }

  return res.json();
}

export default async function Home() {
  const devices = await getDevices();

  return (
    <main
      style={{
        padding: "2rem",
        fontFamily: "system-ui, sans-serif",
        maxWidth: "900px",
        margin: "0 auto"
      }}
    >
      <h1
        style={{
          fontSize: "2.5rem",
          marginBottom: "1.5rem",
          fontWeight: 700
        }}
      >
        NGPCX — Device Compatibility
      </h1>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
          gap: "1.5rem"
        }}
      >
        {devices.map((d: any) => (
          <div
            key={d.id}
            style={{
              border: "1px solid #e5e5e5",
              borderRadius: "12px",
              padding: "1.25rem",
              background: "#fff",
              boxShadow: "0 2px 4px rgba(0,0,0,0.05)"
            }}
          >
            <h2 style={{ margin: "0 0 0.5rem 0", fontSize: "1.25rem" }}>
              {d.brand} {d.model}
            </h2>

            <p style={{ margin: "0.25rem 0", opacity: 0.8 }}>
              CPU: {d.cpu}
            </p>
            <p style={{ margin: "0.25rem 0", opacity: 0.8 }}>
              GPU: {d.gpu}
            </p>
            <p style={{ margin: "0.25rem 0", opacity: 0.8 }}>
              RAM: {d.ram}
            </p>

            <div
              style={{
                marginTop: "0.75rem",
                padding: "0.5rem 0.75rem",
                borderRadius: "8px",
                background: d.compatibility.nextGenReady
                  ? "rgba(0, 200, 0, 0.1)"
                  : "rgba(255, 0, 0, 0.1)",
                color: d.compatibility.nextGenReady ? "green" : "red",
                fontWeight: 600,
                display: "inline-block"
              }}
            >
              {d.compatibility.nextGenReady
                ? "Next‑Gen Ready"
                : "Not Compatible"}
            </div>

            <p style={{ marginTop: "0.75rem", opacity: 0.7 }}>
              {d.compatibility.notes}
            </p>
          </div>
        ))}
      </div>
    </main>
  );
}
