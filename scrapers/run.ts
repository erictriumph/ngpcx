import { AdobeScraper } from "./vendors/AdobeScraper";
import { GitHubArmScraper } from "./community/GitHubArmScraper";
import { mergeIntoDatabase } from "./merge";

async function runAllScrapers() {
  const scrapers = [
    new AdobeScraper(),
    new GitHubArmScraper()
  ];

  for (const scraper of scrapers) {
    const results = await scraper.run();
    await mergeIntoDatabase(results);
  }

  console.log("All scrapers completed.");
}

runAllScrapers();
