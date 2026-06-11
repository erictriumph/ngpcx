import { BaseScraper } from "../BaseScraper";

export class AdobeScraper extends BaseScraper {
  name = "AdobeScraper";
  source = "vendor";
  confidence = 0.95;

  async scrape() {
    // SAMPLE DATA — replace with real scraping later
    return [
      {
        appId: "com.adobe.photoshop",
        name: "Adobe Photoshop",
        publisher: "Adobe",
        categories: ["Creative", "Photo Editing"],
        armSupport: {
          native: true,
          emulation: true,
          rosetta: false,
          notes: "Native ARM64 build available as of v25.0"
        },
        compatibility: {
          status: "supported",
          issues: [],
          workarounds: []
        }
      },
      {
        appId: "com.adobe.premiere",
        name: "Adobe Premiere Pro",
        publisher: "Adobe",
        categories: ["Creative", "Video Editing"],
        armSupport: {
          native: false,
          emulation: true,
          rosetta: false,
          notes: "Runs under emulation but slower"
        },
        compatibility: {
          status: "partial",
          issues: ["Reduced performance under emulation"],
          workarounds: ["Use proxy media"]
        }
      }
    ];
  }
}
