use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::env::temp_dir;
use std::fs;
use std::process::Command;

// ─────────────────────────────────────────
//  Data Structures
// ─────────────────────────────────────────

#[derive(Serialize, Deserialize, Debug)]
struct SystemInfo {
    os_version: String,
    cpu: String,
    ram_gb: u64,
    architecture: String,
    is_arm: bool,
}

#[derive(Serialize, Deserialize, Debug)]
struct AppEntry {
    name: String,
    id: Option<String>,
    version: Option<String>,
    recently_used: bool,
}

#[derive(Serialize, Deserialize, Debug)]
struct ScanPayload {
    scan_mode: String,
    scanned_at: String,
    system: SystemInfo,
    apps: Vec<AppEntry>,
}

// ─────────────────────────────────────────
//  Scan Mode
// ─────────────────────────────────────────

fn get_scan_mode() -> String {
    let args: Vec<String> = std::env::args().collect();
    for arg in &args {
        if arg == "--standard" {
            return "standard".to_string();
        }
        if arg == "--full" {
            return "full".to_string();
        }
    }
    "quick".to_string()
}

// ─────────────────────────────────────────
//  System Info
// ─────────────────────────────────────────

fn get_system_info() -> SystemInfo {
    println!("  Collecting system info...");

    // OS Version
    let os_version = Command::new("cmd")
        .args(["/C", "ver"])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_else(|_| "Unknown".to_string());

    // CPU
    let cpu = Command::new("powershell")
        .args(["-Command", "(Get-WmiObject Win32_Processor).Name"])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_else(|_| "Unknown".to_string());

    // RAM
    let ram_output = Command::new("powershell")
        .args([
            "-Command",
            "(Get-WmiObject Win32_ComputerSystem).TotalPhysicalMemory",
        ])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_else(|_| "0".to_string());

    let ram_bytes: u64 = ram_output.trim().parse().unwrap_or(0);
    let ram_gb = ram_bytes / 1_073_741_824;

    // Architecture
    let arch = std::env::var("PROCESSOR_ARCHITECTURE").unwrap_or_else(|_| "Unknown".to_string());

    let is_arm = arch.to_lowercase().contains("arm");

    SystemInfo {
        os_version,
        cpu,
        ram_gb,
        architecture: arch,
        is_arm,
    }
}

// ─────────────────────────────────────────
//  Prefetch - Recently Used Apps
// ─────────────────────────────────────────

fn get_recent_app_names() -> HashMap<String, bool> {
    let mut recent = HashMap::new();

    let prefetch_dir = "C:\\Windows\\Prefetch";
    if let Ok(entries) = std::fs::read_dir(prefetch_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name_str = name.to_string_lossy().to_lowercase();
            if name_str.ends_with(".pf") {
                // Extract app name from prefetch filename (APP-HASH.pf)
                let app_name = name_str
                    .split('-')
                    .next()
                    .unwrap_or("")
                    .replace(".pf", "")
                    .to_string();
                if !app_name.is_empty() {
                    recent.insert(app_name, true);
                }
            }
        }
    }

    recent
}

// ─────────────────────────────────────────
//  Installed Apps via Winget
// ─────────────────────────────────────────

fn get_installed_apps(mode: &str, recent: &HashMap<String, bool>) -> Vec<AppEntry> {
    println!("  Exporting winget package list...");

    // Write to a temp file
    let temp_path = temp_dir().join("ngpcx-scan.json");
    let temp_str = temp_path.to_str().unwrap_or("C:\\Temp\\ngpcx-scan.json");

    let output = Command::new("winget")
        .args([
            "export",
            "-o",
            temp_str,
            "--accept-source-agreements",
            "--include-versions",
        ])
        .output();

    if let Err(e) = output {
        eprintln!("  Failed to run winget export: {}", e);
        return vec![];
    }

    // Read and parse the JSON
    let json_text = match fs::read_to_string(&temp_path) {
        Ok(text) => text,
        Err(e) => {
            eprintln!("  Failed to read winget export file: {}", e);
            return vec![];
        }
    };

    // Delete temp file immediately
    let _ = fs::remove_file(&temp_path);

    let json: serde_json::Value = match serde_json::from_str(&json_text) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("  Failed to parse winget JSON: {}", e);
            return vec![];
        }
    };

    // Skip these package ID prefixes - system noise
    let skip_prefixes = [
        "microsoft.vcredist",
        "microsoft.vclibs",
        "microsoft.dotnet",
        "microsoft.ui.xaml",
        "microsoft.windowsappruntime",
        "microsoft.directx",
        "microsoft.gameinput",
        "microsoft.appinstaller",
        "microsoft.gaming",
        "winappruntime",
    ];

    let mut apps = Vec::new();

    // Only process the winget source (first source), skip msstore
    if let Some(sources) = json["Sources"].as_array() {
        for source in sources {
            let source_name = source["SourceDetails"]["Name"].as_str().unwrap_or("");

            // Only use winget source, skip msstore
            if source_name != "winget" {
                continue;
            }

            if let Some(packages) = source["Packages"].as_array() {
                for pkg in packages {
                    let id = match pkg["PackageIdentifier"].as_str() {
                        Some(id) => id.to_string(),
                        None => continue,
                    };

                    let id_lower = id.to_lowercase();

                    // Skip system noise
                    if skip_prefixes.iter().any(|p| id_lower.starts_with(p)) {
                        continue;
                    }

                    // Derive a readable name from the ID
                    // e.g. "Google.Chrome.EXE" -> "Google Chrome"
                    let parts: Vec<&str> = id.split('.').collect();
                    let name =
                        if parts.len() >= 2 && parts[0].to_lowercase() == parts[1].to_lowercase() {
                            // Avoid "PuTTY PuTTY" or "7zip 7zip"
                            parts[0].to_string()
                        } else {
                            parts
                                .iter()
                                .take(2)
                                .cloned()
                                .collect::<Vec<&str>>()
                                .join(" ")
                                .replace(".EXE", "")
                                .replace(".exe", "")
                        };

                    // Check recently used
                    let name_lower = name.to_lowercase();
                    let recently_used = recent.iter().any(|(r, _)| {
                        name_lower.contains(r.as_str()) || id_lower.contains(r.as_str())
                    });

                    if mode == "quick" && !recently_used {
                        continue;
                    }

                    apps.push(AppEntry {
                        name,
                        id: Some(id),
                        version: pkg["Version"].as_str().map(|s| s.to_string()),
                        recently_used,
                    });
                }
            }
        }
    }

    apps
}

// ─────────────────────────────────────────
//  Send to Server
// ─────────────────────────────────────────

fn send_to_server(payload: &ScanPayload) -> Result<String, String> {
    let server_url = "http://localhost:3000/api/scan";

    println!("\n  Sending results to server...");

    let client = reqwest::blocking::Client::new();
    let res = client
        .post(server_url)
        .json(payload)
        .send()
        .map_err(|e| format!("Network error: {}", e))?;

    let body = res
        .text()
        .map_err(|e| format!("Failed to read response: {}", e))?;

    Ok(body)
}

// ─────────────────────────────────────────
//  Main
// ─────────────────────────────────────────

fn main() {
    println!("╔══════════════════════════════════════╗");
    println!("║     NGPCX ARM Readiness Scanner      ║");
    println!("╚══════════════════════════════════════╝");

    let mode = get_scan_mode();
    println!("\nScan mode: {}\n", mode.to_uppercase());

    // Step 1: System info
    println!("[1/3] Collecting system information...");
    let system = get_system_info();
    println!("  OS:   {}", system.os_version);
    println!("  CPU:  {}", system.cpu);
    println!("  RAM:  {} GB", system.ram_gb);
    println!("  Arch: {}", system.architecture);
    if system.is_arm {
        println!("  ⚡ This machine is already running ARM Windows!");
    }

    // Step 2: Scan apps
    println!("\n[2/3] Scanning installed applications...");
    let recent = get_recent_app_names();
    println!(
        "  Found {} recently used app signatures in Prefetch",
        recent.len()
    );

    let apps = get_installed_apps(&mode, &recent);
    println!("  Found {} apps to check", apps.len());

    // Step 3: Send to server
    println!("\n[3/3] Checking compatibility...");

    let payload = ScanPayload {
        scan_mode: mode,
        scanned_at: Utc::now().to_rfc3339(),
        system,
        apps,
    };

    match send_to_server(&payload) {
        Ok(response) => {
            println!("  Response received!");
            println!("\n{}", response);
        }
        Err(e) => {
            eprintln!("  Error: {}", e);
            eprintln!("  Make sure the NGPCX server is running locally.");
        }
    }

    println!("\nScan complete. Press Enter to exit.");
    let mut input = String::new();
    std::io::stdin().read_line(&mut input).ok();
}
