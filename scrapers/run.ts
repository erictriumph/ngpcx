import { AdobeScraper } from "./vendors/AdobeScraper";
import { WingetArm64Scraper } from "./community/WingetArm64Scraper";
// import { WingetArm64FallbackScraper } from "./community/WingetArm64FallbackScraper";
import { mergeIntoDatabase } from "./merge";

async function runAllScrapers() {
  const scrapers = [
    new AdobeScraper(),
    new WingetArm64Scraper(),
    // new WingetArm64FallbackScraper()
  ];

  for (const scraper of scrapers) {
    console.log(`\n=== Running ${scraper.name} ===`);
    const results = await scraper.run();
    await mergeIntoDatabase(results);
  }

  console.log("\nAll scrapers completed.");
}

runAllScrapers();
