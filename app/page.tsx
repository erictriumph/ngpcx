export default function Home() {
  return (
    <main
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        minHeight: "100vh",
        padding: "2rem",
        textAlign: "center",
        fontFamily: "system-ui, sans-serif"
      }}
    >
      <h1 style={{ fontSize: "3rem", fontWeight: 700, marginBottom: "1rem" }}>
        Know before you buy.
      </h1>

      <p style={{ fontSize: "1.5rem", opacity: 0.8, maxWidth: "600px" }}>
        Will the next generation of PCs work for you.
      </p>
    </main>
  );
}
