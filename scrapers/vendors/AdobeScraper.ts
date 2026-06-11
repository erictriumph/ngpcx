import { BaseScraper } from "../BaseScraper";

export class AdobeScraper extends BaseScraper {
  name = "AdobeScraper";
  source = "vendor";
  confidence = 0.95;

  async scrape() {
    const html = await fetch("https://helpx.adobe.com/support/arm.html").then(r => r.text());
    const apps = parseAdobeHtml(html);
    return apps;
  }
}
