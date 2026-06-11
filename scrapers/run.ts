import { AdobeScraper } from "./vendors/AdobeScraper.ts";
import { GitHubArmScraper } from "./community/GitHubArmScraper.ts";
import { mergeIntoDatabase } from "./merge";

async function runAllScrapers() {
  const scrapers = [
    new AdobeScraper(),
    new GitHubArmScraper()
  ];

  for (const scraper of scrapers) {
    console.log(`\n=== Running ${scraper.name} ===`);
    const results = await scraper.run();
    await mergeIntoDatabase(results);
  }

  console.log("\nAll scrapers completed.");
}

runAllScrapers();
