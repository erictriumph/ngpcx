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
struct DeviceEntry {
    name: String,
    class: String,
    hardware_id: Option<String>,
    days_ago: Option<f64>,
    is_network: bool,
}

#[derive(Serialize, Deserialize, Debug)]
struct ScanPayload {
    scan_mode: String,
    scanned_at: String,
    session_id: Option<String>,
    system: SystemInfo,
    apps: Vec<AppEntry>,
    devices: Vec<DeviceEntry>, // ADD THIS LINE
}

// ─────────────────────────────────────────
//  Scan Mode
// ─────────────────────────────────────────

fn get_cli_scan_mode() -> Option<String> {
    let args: Vec<String> = std::env::args().collect();
    for arg in &args {
        if arg == "--quick" {
            return Some("quick".to_string());
        }
        if arg == "--standard" {
            return Some("standard".to_string());
        }
        if arg == "--full" {
            return Some("full".to_string());
        }
    }
    None
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

    // Architecture — check PROCESSOR_ARCHITEW6432 first, since it reflects the
    // true native OS architecture even when this process is running under
    // emulation (e.g. this x64 exe on a real ARM64 machine). Windows only sets
    // this variable when emulation is active, so falling back to
    // PROCESSOR_ARCHITECTURE on non-emulated machines is correct.
    let arch = std::env::var("PROCESSOR_ARCHITEW6432")
        .or_else(|_| std::env::var("PROCESSOR_ARCHITECTURE"))
        .unwrap_or_else(|_| "Unknown".to_string());

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
//  Connected/Recent Devices
// ─────────────────────────────────────────

fn get_devices(mode: &str) -> Vec<DeviceEntry> {
    println!("  Scanning connected/recent devices...");

    let ps_script = r#"
$classes = @('Printer','Image','MEDIA','Biometric','SmartCardReader','Camera','HIDClass')
$present = (Get-PnpDevice -PresentOnly:$true).InstanceId

Get-PnpDevice | Where-Object {
    $_.Class -in $classes -and
    $_.InstanceId -notmatch '^SW\\' -and
    $_.InstanceId -match 'VID_[0-9A-F]{4}&PID_[0-9A-F]{4}'
} | ForEach-Object {
    $vidPid = [regex]::Match($_.InstanceId, 'VID_[0-9A-F]{4}&PID_[0-9A-F]{4}').Value
    $isPresent = $present -contains $_.InstanceId
    $arrival = (Get-PnpDeviceProperty -InstanceId $_.InstanceId -KeyName 'DEVPKEY_Device_LastArrivalDate' -ErrorAction SilentlyContinue).Data
    $removal = (Get-PnpDeviceProperty -InstanceId $_.InstanceId -KeyName 'DEVPKEY_Device_LastRemovalDate' -ErrorAction SilentlyContinue).Data

    $arrivalDaysAgo = if ($arrival) { [math]::Round(((Get-Date) - $arrival).TotalDays, 1) } else { $null }
    $removalDaysAgo = if ($removal) { [math]::Round(((Get-Date) - $removal).TotalDays, 1) } else { $null }
    $recency = if ($removalDaysAgo -ne $null) { $removalDaysAgo } else { $arrivalDaysAgo }

    [PSCustomObject]@{
        Name = $_.FriendlyName
        Class = $_.Class
        VidPid = $vidPid
        IsPresent = $isPresent
        DaysAgo = $recency
    }
} | ConvertTo-Json
"#;

    let output = Command::new("powershell")
        .args(["-NoProfile", "-Command", ps_script])
        .output();

    let output = match output {
        Ok(o) => o,
        Err(e) => {
            eprintln!("  Failed to run device scan: {}", e);
            return vec![];
        }
    };

    let json_text = String::from_utf8_lossy(&output.stdout);
    if json_text.trim().is_empty() {
        return vec![];
    }

    let json: serde_json::Value = match serde_json::from_str(&json_text) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("  Failed to parse device JSON: {}", e);
            return vec![];
        }
    };

    let items: Vec<&serde_json::Value> = if json.is_array() {
        json.as_array().unwrap().iter().collect()
    } else {
        vec![&json]
    };

    // Group raw rows by VID/PID first, so we can pick the best
    // representative name per physical device before filtering by tier.
    let mut grouped: HashMap<String, Vec<(String, String, bool, Option<f64>)>> = HashMap::new();

    for item in items {
        let name = item["Name"]
            .as_str()
            .unwrap_or("Unknown Device")
            .to_string();
        let class = item["Class"].as_str().unwrap_or("Unknown").to_string();
        let vid_pid = item["VidPid"].as_str().unwrap_or("").to_string();
        let is_present = item["IsPresent"].as_bool().unwrap_or(false);
        let days_ago = item["DaysAgo"].as_f64();

        if vid_pid.is_empty() {
            continue;
        }

        grouped
            .entry(vid_pid)
            .or_insert_with(Vec::new)
            .push((name, class, is_present, days_ago));
    }

    fn is_generic_name(name: &str) -> bool {
        let lower = name.to_lowercase();
        if lower.contains("fido") {
            return false; // "fido" is a meaningful signal, not generic noise
        }
        lower.starts_with("hid-compliant")
            || lower.starts_with("usb input device")
            || lower.starts_with("usb composite device")
            || lower == "unknown device"
            || lower == "keyboard generic"
    }

    let mut devices = Vec::new();

    let review_classes = ["Biometric", "SmartCardReader"];

    for (vid_pid, rows) in grouped {
        // Prefer a row with a non-generic name for display/search purposes.
        let best = rows
            .iter()
            .find(|(name, _, _, _)| !is_generic_name(name))
            .unwrap_or(&rows[0]);

        let name = best.0.clone();

        // For classification, use the most conservative class seen across
        // ALL interfaces of this device — a composite device that includes
        // any sensitive interface (biometric/smart-card) should stay
        // flagged for review even if it also exposes a generic HID/media
        // interface elsewhere.
        let class = rows
            .iter()
            .map(|(_, c, _, _)| c.clone())
            .find(|c| review_classes.contains(&c.as_str()))
            .unwrap_or_else(|| best.1.clone());

        let is_present = rows.iter().any(|(_, _, present, _)| *present);
        let days_ago =
            rows.iter()
                .filter_map(|(_, _, _, d)| *d)
                .fold(None, |acc: Option<f64>, d| match acc {
                    None => Some(d),
                    Some(a) => Some(a.min(d)),
                });

        let include = match mode {
            "quick" => is_present || days_ago.map_or(false, |d| d <= 8.0),
            "standard" => is_present || days_ago.map_or(true, |d| d <= 60.0),
            _ => true,
        };

        if include {
            devices.push(DeviceEntry {
                name,
                class,
                hardware_id: Some(vid_pid),
                days_ago,
                is_network: false,
            });
        }
    }

    devices
}

fn extract_hardware_id(instance_id: &str) -> Option<String> {
    let vid_pos = instance_id.find("VID_")?;
    let pid_pos = instance_id.find("PID_")?;
    let vid = &instance_id[vid_pos..vid_pos + 8];
    let pid = &instance_id[pid_pos..pid_pos + 8];
    Some(format!("{}&{}", vid, pid))
}

fn get_printers() -> Vec<DeviceEntry> {
    println!("  Scanning installed printers...");

    let ps_script = r#"
Get-Printer | Where-Object {
    $_.DriverName -notmatch 'PDF|OneNote|Fax|XPS|Virtual' -and
    $_.PortName -notmatch 'PDF|OneNote|Fax|XPS|nul:|PORTPROMPT'
} | Group-Object DriverName | ForEach-Object {
    [PSCustomObject]@{
        Name = $_.Group[0].DriverName
        IsNetwork = [bool]($_.Group.PortName -match 'IP_|WSD-')
    }
} | ConvertTo-Json
"#;

    let output = Command::new("powershell")
        .args(["-NoProfile", "-Command", ps_script])
        .output();

    let output = match output {
        Ok(o) => o,
        Err(e) => {
            eprintln!("  Failed to run printer scan: {}", e);
            return vec![];
        }
    };

    let json_text = String::from_utf8_lossy(&output.stdout);
    if json_text.trim().is_empty() {
        return vec![];
    }

    let json: serde_json::Value = match serde_json::from_str(&json_text) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("  Failed to parse printer JSON: {}", e);
            return vec![];
        }
    };

    let items: Vec<&serde_json::Value> = if json.is_array() {
        json.as_array().unwrap().iter().collect()
    } else {
        vec![&json]
    };

    let mut printers = Vec::new();

    for item in items {
        let name = item["Name"]
            .as_str()
            .unwrap_or("Unknown Printer")
            .to_string();
        let is_network = item["IsNetwork"].as_bool().unwrap_or(false);

        printers.push(DeviceEntry {
            name,
            class: "Printer".to_string(),
            hardware_id: None,
            days_ago: None,
            is_network,
        });
    }

    printers
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

fn start_local_server() -> (Option<String>, Option<String>) {
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    let result: Arc<Mutex<(Option<String>, Option<String>)>> = Arc::new(Mutex::new((None, None)));
    let result_clone = Arc::clone(&result);

    let listener = match TcpListener::bind("127.0.0.1:7878") {
        Ok(l) => l,
        Err(e) => {
            eprintln!("  Could not bind to port 7878: {}", e);
            return (None, None);
        }
    };

    println!("  Listening on localhost:7878 for browser connection...");
    listener.set_nonblocking(true).ok();

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
                stream.set_read_timeout(Some(Duration::from_secs(5))).ok();

                let reader = match stream.try_clone() {
                    Ok(cloned) => BufReader::new(cloned),
                    Err(e) => {
                        eprintln!("  Failed to clone stream: {}", e);
                        break;
                    }
                };
                
                let mut request_line = String::new();
                if let Some(Ok(line)) = reader.lines().next() {
                    request_line = line;
                }

                let path = request_line.split_whitespace().nth(1).unwrap_or("");

                let session = path
                    .split("session=")
                    .nth(1)
                    .map(|s| s.split('&').next().unwrap_or(s).to_string());
                let level = path
                    .split("level=")
                    .nth(1)
                    .map(|s| s.split('&').next().unwrap_or(s).to_string());

                if let Some(ref id) = session {
                    println!("  Browser connected — session ID: {}", id);
                }
                if let Some(ref lvl) = level {
                    println!("  Requested scan level: {}", lvl);
                }

                *result_clone.lock().unwrap() = (session, level);

                let response = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nAccess-Control-Allow-Origin: *\r\n\r\n{\"connected\":true}";
                let _ = stream.write_all(response.as_bytes());
                break;
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(100));
                continue;
            }
            Err(e) => {
                eprintln!("  Accept error: {}", e);
                break;
            }
        }
    }

    let final_result = result.lock().unwrap().clone();
    final_result
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

    let cli_mode = get_cli_scan_mode();
    let base_url = get_server_url();

    // Step 1: System info
    println!("\n[1/4] Collecting system information...");
    let system = get_system_info();
    println!("  OS:   {}", system.os_version);
    println!("  CPU:  {}", system.cpu);
    println!("  RAM:  {} GB", system.ram_gb);
    println!("  Arch: {}", system.architecture);
    if system.is_arm {
        println!("  ⚡ This machine is already running ARM Windows!");
    }

    // Step 2: Wait for browser handshake (now happens BEFORE scanning)
    println!("\n[2/4] Waiting for browser connection...");
    println!("  (Make sure you clicked 'Run Scan' on the website first)");

    let (session_id, browser_level) = start_local_server();

    let session_id = if session_id.is_none() {
        println!("  No browser connected — creating standalone session...");
        let client = reqwest::blocking::Client::new();
        let session_url = format!("{}/api/session", base_url);
        match client.post(&session_url).send() {
            Ok(res) => match res.json::<serde_json::Value>() {
                Ok(v) => {
                    let id = v["session_id"].as_str().unwrap_or("").to_string();
                    println!("  Session ID: {}", id);
                    if id.is_empty() {
                        None
                    } else {
                        Some(id)
                    }
                }
                Err(e) => {
                    eprintln!("  Failed to parse session response: {}", e);
                    None
                }
            },
            Err(e) => {
                eprintln!("  Failed to create session: {}", e);
                None
            }
        }
    } else {
        session_id
    };

    // CLI flag wins (dev convenience) > browser-selected level > default "quick"
    let mode = cli_mode
        .or(browser_level)
        .unwrap_or_else(|| "quick".to_string());
    println!("\nScan mode: {}", mode.to_uppercase());
    println!("Server:    {}", base_url);

    // Step 3: Scan apps
    println!("\n[3/4] Scanning installed applications...");
    let recent = get_recent_app_names();
    println!(
        "  Found {} recently used app signatures in Prefetch",
        recent.len()
    );

    let mut apps = get_installed_apps(&mode, &recent);
    if apps.is_empty() && mode == "quick" {
        println!("  Quick mode found no apps (Prefetch unavailable) — falling back to standard...");
        apps = get_installed_apps("standard", &recent);
    }
    println!("  Found {} apps to check", apps.len());

    println!("\nScanning connected devices...");
    let mut devices = get_devices(&mode);
    println!("  Found {} relevant device(s)", devices.len());
    let printers = get_printers();
    println!("  Found {} printer(s)", printers.len());
    devices.extend(printers);

    // Step 4: Send to server
    println!("\n[4/4] Checking compatibility...");
    let payload = ScanPayload {
        scan_mode: mode,
        scanned_at: Utc::now().to_rfc3339(),
        session_id,
        system,
        apps,
        devices,
    };

    match send_to_server(&payload, &base_url) {
        Ok(_) => {
            println!("  Results submitted successfully!");
            println!("\n  Your report is ready. Check your browser.");
        }
        Err(e) => eprintln!("  Error: {}", e),
    }

    println!("\nScan complete. Press Enter to exit.");
    let mut input = String::new();
    std::io::stdin().read_line(&mut input).ok();
}
