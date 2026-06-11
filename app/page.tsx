"use client";

import { useEffect, useState } from "react";
import { Logo } from "@/components/Logo";

async function getDevices() {
  const res = await fetch(`${process.env.NEXT_PUBLIC_BASE_URL}/api/devices`, {
    cache: "no-store"
  });

  if (!res.ok) {
    throw new Error("Failed to fetch devices");
  }

  return res.json();
}

export default function Home() {
  const [devices, setDevices] = useState([]);
  const [dark, setDark] = useState(false);

  useEffect(() => {
    getDevices().then(setDevices);
  }, []);

  return (
    <div
      style={{
        fontFamily: "system-ui, sans-serif",
        background: dark
          ? "linear-gradient(to bottom, #0f172a, #1e293b)"
          : "linear-gradient(to bottom, #f8fafc, #eef2f7)",
        color: dark ? "#f1f5f9" : "#111",
        minHeight: "100vh",
        transition: "all 0.3s ease"
      }}
    >
      {/* NAV BAR */}
      <nav
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "1rem 2rem",
          borderBottom: dark ? "1px solid #334155" : "1px solid #e2e8f0",
          backdropFilter: "blur(8px)",
          position: "sticky",
          top: 0,
          zIndex: 10
        }}
      >
        <Logo dark={dark} />

        <button
          onClick={() => setDark(!dark)}
          style={{
            padding: "0.5rem 1rem",
            borderRadius: "8px",
            border: "none",
            cursor: "pointer",
            background: dark ? "#334155" : "#e2e8f0",
            color: dark ? "#f1f5f9" : "#111",
            transition: "all 0.2s ease"
          }}
        >
          {dark ? "☀️ Light Mode" : "🌙 Dark Mode"}
        </button>
      </nav>

      {/* HERO */}
      <section
        style={{
          maxWidth: "900px",
          margin: "2.5rem auto 3rem auto",
          textAlign: "center",
          padding: "0 1rem"
        }}
      >
        <h1
          style={{
            fontSize: "3rem",
            fontWeight: 800,
            marginBottom: "1rem"
          }}
        >
          Know Before You Buy
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
          NGPCX evaluates whether today’s laptops and desktops are ready for the
          next generation of PC standards — AI‑accelerated workloads, new CPU/GPU
          architectures, and emerging compatibility requirements.
        </p>
      </section>

      {/* DEVICE GRID */}
      <section
        style={{
          maxWidth: "1000px",
          margin: "0 auto",
          padding: "0 1rem 4rem 1rem",
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))",
          gap: "1.75rem"
        }}
      >
        {devices.map((d: any) => (
          <div
            key={d.id}
            style={{
              background: dark ? "#1e293b" : "#fff",
              borderRadius: "14px",
              padding: "1.5rem",
              boxShadow: dark
                ? "0 4px 12px rgba(0,0,0,0.4)"
                : "0 4px 12px rgba(0,0,0,0.08)",
              border: dark ? "1px solid #334155" : "1px solid #e5e7eb",
              transition: "all 0.3s ease"
            }}
          >
            <h2
              style={{
                margin: "0 0 0.5rem 0",
                fontSize: "1.35rem",
                fontWeight: 700
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
                color: d.compatibility.nextGenReady ? "#10b981" : "#ef4444",
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
    </div>
  );
}

