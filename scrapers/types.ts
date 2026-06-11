// Unified normalized structure for ARM compatibility data
export interface ArmNormalizedEntry {
  id: string;                     // Unique identifier (packageId, appId, or name)
  name: string;                   // Human-readable app name
  publisher?: string;             // Optional publisher/author
  architectures: string[];        // ["arm64"], ["x64"], etc.
  armSupport: "native" | "x64-emulated" | "x86-emulated" | "unsupported" | "unknown";
  source: string;                 // Which scraper/repo produced this entry
  notes?: string;                 // Optional compatibility notes
  url?: string;
  icon?: string;
}

// Optional: raw data types for future scrapers
export interface RawData {
  [key: string]: any;
}
