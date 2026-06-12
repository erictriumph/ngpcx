function writeJsonOutput(results: any) {
  // Shared output folder at project root
  const outputDir = path.join(process.cwd(), "..", "data");
  const outputPath = path.join(outputDir, "scan-results.json");

  try {
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    fs.writeFileSync(outputPath, JSON.stringify(results, null, 2), "utf8");
    console.log(`✔ Scan results written to ${outputPath}`);
  } catch (err) {
    console.error("Failed to write scan-results.json:", err);
  }
}
