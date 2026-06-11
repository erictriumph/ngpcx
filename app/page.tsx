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
        fontFamily: "system-ui, sans-serif",
        background: "linear-gradient(to bottom, #f8fafc, #eef2f7)",
        minHeight: "100vh",
        padding: "3rem 1.5rem"
      }}
    >
      {/* HERO SECTION */}
      <section
        style={{
          maxWidth: "900px",
          margin: "0 auto 3rem auto",
          textAlign: "center"
        }}
      >
        <h1
          style={{
            fontSize: "3rem",
            fontWeight: 800,
            marginBottom: "1rem",
            color: "#111"
          }}
        >
          NGPCX — Know Before You Buy
        </h1>

        <p
          style={{
            fontSize: "1.25rem",
            maxWidth: "700px",
            margin: "0 auto",
            opacity: 0.85,
            lineHeight: 1.6
          }}
        >
          NGPCX helps you understand whether today’s laptops and desktops are
          ready for the next generation of PC standards — new architectures,
          AI‑accelerated workloads, and emerging compatibility requirements.
          Before you spend thousands on new hardware, NGPCX gives you clarity.
        </p>
      </section>

      {/* DEVICE GRID */}
      <section
        style={{
          maxWidth: "1000px",
          margin: "0 auto",
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))",
          gap: "1.75rem"
        }}
      >
        {devices.map((d: any) => (
          <div
            key={d.id}
            style={{
              background: "#fff",
              borderRadius: "14px",
              padding: "1.5rem",
              boxShadow: "0 4px 12px rgba(0,0,0,0.08)",
              border: "1px solid #e5e7eb"
            }}
          >
            <h2
              style={{
                margin: "0 0 0.5rem 0",
                fontSize: "1.35rem",
                fontWeight: 700,
                color: "#111"
              }}
            >
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
                marginTop: "1rem",
                padding: "0.6rem 0.9rem",
                borderRadius: "8px",
                background: d.compatibility.nextGenReady
                  ? "rgba(16, 185, 129, 0.15)"
                  : "rgba(239, 68, 68, 0.15)",
                color: d.compatibility.nextGenReady ? "#059669" : "#dc2626",
                fontWeight: 700,
                display: "inline-block"
              }}
            >
              {d.compatibility.nextGenReady
                ? "✓ Next‑Gen Ready"
                : "✗ Not Compatible"}
            </div>

            <p
              style={{
                marginTop: "0.75rem",
                opacity: 0.75,
                lineHeight: 1.5
              }}
            >
              {d.compatibility.notes}
            </p>
          </div>
        ))}
      </section>

      {/* FOOTER */}
      <footer
        style={{
          marginTop: "4rem",
          textAlign: "center",
          opacity: 0.6,
          fontSize: "0.9rem"
        }}
      >
        NGPCX — Helping you make smarter hardware decisions in a rapidly
        changing PC landscape.
      </footer>
    </main>
  );
}
