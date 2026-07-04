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
    session_id: Option<String>,
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

fn send_to_server(payload: &ScanPayload, base_url: &str) -> Result<String, String> {
    let url = format!("{}/api/scan", base_url);

    println!("\n  Sending results to server...");

    let client = reqwest::blocking::Client::new();
    let res = client
        .post(&url)
        .json(payload)
        .send()
        .map_err(|e| format!("Network error: {}", e))?;

    let body = res
        .text()
        .map_err(|e| format!("Failed to read response: {}", e))?;

    Ok(body)
}

fn start_local_server() -> Option<String> {
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    let result: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let result_clone = Arc::clone(&result);

    let listener = match TcpListener::bind("127.0.0.1:7878") {
        Ok(l) => l,
        Err(e) => {
            eprintln!("  Could not bind to port 7878: {}", e);
            return None;
        }
    };

    println!("  Listening on localhost:7878 for browser connection...");

    // Set a 20 second timeout on accept
    listener.set_nonblocking(true).ok()?;

    let start = std::time::Instant::now();
    let timeout = Duration::from_secs(20);

    loop {
        if start.elapsed() > timeout {
            println!("  Browser connection timed out — proceeding without session handshake");
            break;
        }

        match listener.accept() {
            Ok((mut stream, _)) => {
                stream.set_nonblocking(false).ok();
                let reader = BufReader::new(stream.try_clone().unwrap());
                let mut request_line = String::new();
                if let Some(Ok(line)) = reader.lines().next() {
                    request_line = line;
                }

                let extracted = request_line
                    .split_whitespace()
                    .nth(1)
                    .and_then(|path| path.split("session=").nth(1))
                    .map(|s| s.split('&').next().unwrap_or(s).to_string());

                if let Some(ref id) = extracted {
                    println!("  Browser connected — session ID: {}", id);
                    *result_clone.lock().unwrap() = extracted;
                }

                let response = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nAccess-Control-Allow-Origin: *\r\n\r\n{\"connected\":true}";
                let _ = stream.write_all(response.as_bytes());
                break;
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                // No connection yet, wait a bit
                std::thread::sleep(Duration::from_millis(100));
                continue;
            }
            Err(e) => {
                eprintln!("  Accept error: {}", e);
                break;
            }
        }
    }

    let id = result.lock().unwrap().clone();
    id
}

fn get_server_url() -> String {
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--local") {
        "http://localhost:3000".to_string()
    } else {
        "https://ngpcx.com".to_string()
    }
}

// ─────────────────────────────────────────
//  Main
// ─────────────────────────────────────────

fn main() {
    println!("╔══════════════════════════════════════╗");
    println!("║     NGPCX ARM Readiness Scanner      ║");
    println!("╚══════════════════════════════════════╝");

    let mode = get_scan_mode();
    let base_url = get_server_url();
    println!("\nScan mode: {}", mode.to_uppercase());
    println!("Server:    {}\n", base_url);

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

    let mut apps = get_installed_apps(&mode, &recent);
    
    // If quick mode found nothing (Prefetch unavailable), fall back to standard
    if apps.is_empty() && mode == "quick" {
        println!("  Quick mode found no apps (Prefetch unavailable) — falling back to standard...");
        apps = get_installed_apps("standard", &recent);
    }
    
    println!("  Found {} apps to check", apps.len());

// Step 3: Send to server
    println!("\n[3/3] Checking compatibility...");

    // Wait for browser to connect and provide session ID
    println!("  Waiting for browser connection on localhost:7878...");
    println!("  (Make sure you clicked 'Run Scan' on the website first)");
    
    let session_id = start_local_server().unwrap_or_default();

    // If no browser connected, create our own session
    let session_id = if session_id.is_empty() {
        println!("  No browser connected — creating standalone session...");
        let client = reqwest::blocking::Client::new();
        let session_url = format!("{}/api/session", base_url);
        match client.post(&session_url).send() {
            Ok(res) => match res.json::<serde_json::Value>() {
                Ok(v) => {
                    let id = v["session_id"].as_str().unwrap_or("").to_string();
                    println!("  Session ID: {}", id);
                    id
                }
                Err(e) => {
                    eprintln!("  Failed to parse session response: {}", e);
                    String::new()
                }
            },
            Err(e) => {
                eprintln!("  Failed to create session: {}", e);
                String::new()
            }
        }
    } else {
        session_id
    };

    let payload = ScanPayload {
        scan_mode: mode,
        scanned_at: Utc::now().to_rfc3339(),
        session_id: if session_id.is_empty() {
            None
        } else {
            Some(session_id)
        },
        system,
        apps,
    };

    match send_to_server(&payload, &base_url) {
        Ok(_) => {
            println!("  Results submitted successfully!");
            println!("\n  Your report is ready. Check your browser.");
        }
        Err(e) => {
            eprintln!("  Error: {}", e);
        }
    }
    println!("\nScan complete. Press Enter to exit.");
    let mut input = String::new();
    std::io::stdin().read_line(&mut input).ok();
}