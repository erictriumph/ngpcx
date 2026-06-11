// /scrapers/BaseScraper.ts

export interface ScraperResult {
  appId: string;
  name: string;
  publisher?: string;
  categories?: string[];
  armSupport?: {
    native: boolean;
    emulation: boolean;
    rosetta: boolean;
    notes?: string;
  };
  performance?: {
    cpuImpact: string;
    gpuImpact: string;
    npuRequired: boolean;
    memoryImpact: string;
  };
  compatibility?: {
    status: string;
    issues?: string[];
    workarounds?: string[];
  };
  verification: {
    source: string;
    confidence: number;
    lastChecked: string;
  };
}

export abstract class BaseScraper {
  abstract name: string;
  abstract source: string;
  abstract confidence: number;

  // Main entry point for all scrapers
  async run(): Promise<ScraperResult[]> {
    console.log(`[${this.name}] Starting scrape…`);

    try {
      const raw = await this.scrape();
      const normalized = raw.map(entry => this.normalize(entry));

      console.log(
        `[${this.name}] Completed. ${normalized.length} entries normalized.`
      );

      return normalized;
    } catch (err) {
      console.error(`[${this.name}] Scraper failed:`, err);
      return [];
    }
  }

  // Each scraper implements its own scraping logic
  protected abstract scrape(): Promise<any[]>;

  // Normalizes raw scraped data into NGPCX schema
  protected normalize(raw: any): ScraperResult {
    return {
      appId: raw.appId,
      name: raw.name,
      publisher: raw.publisher || null,
      categories: raw.categories || [],
      armSupport: raw.armSupport || {
        native: false,
        emulation: false,
        rosetta: false,
        notes: ""
      },
      performance: raw.performance || {
        cpuImpact: "unknown",
        gpuImpact: "unknown",
        npuRequired: false,
        memoryImpact: "unknown"
      },
      compatibility: raw.compatibility || {
        status: "unknown",
        issues: [],
        workarounds: []
      },
      verification: {
        source: this.source,
        confidence: this.confidence,
        lastChecked: new Date().toISOString()
      }
    };
  }
}
