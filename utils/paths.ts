import path from "path";
import { fileURLToPath } from "url";

// __dirname inside /utils always resolves to <project-root>/utils
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ⭐ Project root = one level above /utils
export const PROJECT_ROOT = path.join(__dirname, "..");

// ⭐ Shared data directory
export const DATA_DIR = path.join(PROJECT_ROOT, "data");

// ⭐ Shared scan results file
export const SCAN_RESULTS_FILE = path.join(DATA_DIR, "scan-results.json");
