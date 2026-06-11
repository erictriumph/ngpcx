import { AdobeScraper } from "./vendors/AdobeScraper";
import { WingetArm64Scraper } from "./community/WingetArm64Scraper";
// import { WingetArm64FallbackScraper } from "./community/WingetArm64FallbackScraper";
import { mergeIntoDatabase } from "./merge";
import { TopAppsScraper } from "./community/TopAppsScraper";
import { GitHubPopularScraper } from "./community/GitHubPopularScraper";
import { WingetPartialScraper } from "./community/WingetPartialScraper";

async function runAllScrapers() {
  const scrapers = [
    new AdobeScraper(),
    new WingetArm64Scraper(),
    // new WingetArm64FallbackScraper()
    new TopAppsScraper(),
    new GitHubPopularScraper(),
    new WingetPartialScraper(),
  ];

  for (const scraper of scrapers) {
    console.log(`\n=== Running ${scraper.name} ===`);
    const results = await scraper.run();
    await mergeIntoDatabase(results);
  }

  console.log("\nAll scrapers completed.");
}

runAllScrapers();
