// /scrapers/BaseScraper.ts

export interface ScraperResult {
  // Old scrapers (Adobe, GitHub, etc.)
  appId?: string;

  // New scrapers (Winget, Store, Local Scanner)
  id?: string;

  // Common fields
  name: string;
  publisher?: string;
  categories?: string[];

  // Old-style ARM support (Adobe, GitHub scrapers)
  armSupport?: {
    native: boolean;
    emulation: boolean;
    rosetta: boolean;
    notes?: string;
  };

  // New-style ARM support (Winget, Store, Local Scanner)
  architectures?: string[];
  armSupportLevel?: "native" | "x64-emulated" | "x86-emulated" | "unsupported" | "unknown";

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

  source?: string;
  notes?: string;

  verification: {
    source: string;
    confidence: number;
    lastChecked: string;
  };

  // Allow future scrapers to add fields without breaking the type
  [key: string]: any;
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
      // Support both old and new scrapers
      appId: raw.appId,
      id: raw.id,

      name: raw.name,
      publisher: raw.publisher || null,
      categories: raw.categories || [],

      // Old-style armSupport (Adobe, GitHub)
      armSupport: raw.armSupport || {
        native: false,
        emulation: false,
        rosetta: false,
        notes: ""
      },

      // New-style ARM support (Winget, Store, Local Scanner)
      architectures: raw.architectures,
      armSupportLevel: raw.armSupportLevel,

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

      source: raw.source,
      notes: raw.notes,

      verification: {
        source: this.source,
        confidence: this.confidence,
        lastChecked: new Date().toISOString()
      }
    };
  }
}
