use chrono::{NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::collections::HashSet;
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
    publisher: Option<String>,
}

#[derive(Serialize, Deserialize, Debug)]
struct ArpAppEntry {
    name: String,
    version: Option<String>,
    publisher: Option<String>,
    install_date_raw: Option<String>,
    days_ago: Option<f64>,
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

// Maps app name (derived from Prefetch filename) -> days since the .pf file
// was last modified, used as a cheap last-run proxy. mtime updates each time
// Windows rewrites the Prefetch file (i.e. each time the app runs), so it
// tracks usage recency, not just "was this ever run at some point."
fn get_recent_app_names() -> HashMap<String, f64> {
    let mut recent = HashMap::new();
    let now = std::time::SystemTime::now();

    let prefetch_dir = "C:\\Windows\\Prefetch";
    if let Ok(entries) = std::fs::read_dir(prefetch_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name_str = name.to_string_lossy().to_lowercase();
            if name_str.ends_with(".pf") {
                let app_name = name_str
                    .split('-')
                    .next()
                    .unwrap_or("")
                    .trim_end_matches(".exe")
                    .to_string();
                if app_name.is_empty() {
                    continue;
                }

                let days_ago = entry
                    .metadata()
                    .and_then(|m| m.modified())
                    .ok()
                    .and_then(|modified| now.duration_since(modified).ok())
                    .map(|d| d.as_secs_f64() / 86400.0);

                if let Some(days) = days_ago {
                    recent
                        .entry(app_name)
                        .and_modify(|existing: &mut f64| {
                            if days < *existing {
                                *existing = days;
                            }
                        })
                        .or_insert(days);
                }
            }
        }
    }

    recent
}

// Currently-running processes, used as a Prefetch-independent recency signal —
// covers systems where Windows has Prefetch tracking disabled entirely (common
// on SSD installs), which Prefetch-only detection can't see at all.
fn get_running_process_names() -> HashSet<String> {
    let mut running = HashSet::new();

    let output = Command::new("powershell")
        .args([
            "-NoProfile",
            "-Command",
            "Get-Process | Select-Object -ExpandProperty ProcessName",
        ])
        .output();

    if let Ok(o) = output {
        let text = String::from_utf8_lossy(&o.stdout);
        for line in text.lines() {
            let name = line.trim().to_lowercase();
            if !name.is_empty() {
                running.insert(name);
            }
        }
    }

    running
}

// Best (smallest) days-ago among any Prefetch entries whose key is a substring
// of `haystack` (app name or winget id, lowercased) — mirrors the contains-match
// already used for name/id matching elsewhere in this file.
fn find_recency_days(haystack: &str, recent: &HashMap<String, f64>) -> Option<f64> {
    recent
        .iter()
        .filter(|(key, _)| haystack.contains(key.as_str()))
        .map(|(_, days)| *days)
        .fold(None, |best, days| match best {
            Some(b) if b <= days => Some(b),
            _ => Some(days),
        })
}

fn is_process_running(haystack: &str, running: &HashSet<String>) -> bool {
    running.iter().any(|key| haystack.contains(key.as_str()))
}

// Quick: any Prefetch record at all, or currently running (unchanged from the
// original boolean-presence behavior, just also OR'd with live process state).
// Standard: used within the last 60 days, or no recency data at all (mirrors
// the device tiering formula's "unknown = keep" rule — a missing Prefetch
// record doesn't prove staleness, since Prefetch itself can be disabled
// system-wide), or currently running.
// Full: everything, unfiltered.
fn include_by_recency(mode: &str, is_running: bool, days_ago: Option<f64>) -> bool {
    match mode {
        "quick" => is_running || days_ago.is_some(),
        "standard" => is_running || days_ago.map_or(true, |d| d <= 60.0),
        _ => true,
    }
}

// Standard mode's device recency window varies by class: Camera/HIDClass/
// MEDIA/Biometric/SmartCardReader tend to cluster into "near-daily" or
// "effectively abandoned" (printers already bypass this filter entirely),
// so a tight 14-day window fits. Net/Display (docks, USB-Ethernet/WiFi
// adapters, DisplayLink-style graphics) behave more like the app side of
// the report — someone might use a travel dock monthly and still want it
// flagged — so they keep a 60-day window, matching the app-tiering logic.
fn standard_threshold_days(class: &str) -> f64 {
    match class {
        "Net" | "Display" => 60.0,
        _ => 14.0,
    }
}

// ─────────────────────────────────────────
//  Connected/Recent Devices
// ─────────────────────────────────────────

fn get_devices(mode: &str) -> Vec<DeviceEntry> {
    if mode == "quick" {
        println!("  Scanning connected devices...");
    } else {
        println!("  Scanning connected/recent devices (checking device history, this can take a moment)...");
    }

    let ps_script = if mode == "quick" {
        // Fast path: presence-only, no per-device property lookups.
        // This is what actually makes Quick fast — the LastArrival/LastRemoval
        // lookups below are the expensive part and quick mode doesn't need them,
        // since "currently present" alone qualifies for every tier.
        r#"
$classes = @('Printer','Image','MEDIA','Biometric','SmartCardReader','Camera','HIDClass','Net','Display')

Get-PnpDevice -PresentOnly:$true | Where-Object {
    $_.Class -in $classes -and
    $_.InstanceId -notmatch '^SW\\' -and
    $_.InstanceId -match 'VID_[0-9A-F]{4}&PID_[0-9A-F]{4}'
} | ForEach-Object {
    $vidPid = [regex]::Match($_.InstanceId, 'VID_[0-9A-F]{4}&PID_[0-9A-F]{4}').Value
    [PSCustomObject]@{
        Name = $_.FriendlyName
        Class = $_.Class
        VidPid = $vidPid
        IsPresent = $true
        DaysAgo = $null
    }
} | ConvertTo-Json
"#
    } else {
        r#"
$classes = @('Printer','Image','MEDIA','Biometric','SmartCardReader','Camera','HIDClass','Net','Display')
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
"#
    };

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
            "standard" => is_present || days_ago.map_or(true, |d| d <= standard_threshold_days(&class)),
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

fn get_installed_apps(
    mode: &str,
    recent: &HashMap<String, f64>,
    running: &HashSet<String>,
) -> Vec<AppEntry> {
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

                    // Check recency via Prefetch mtime and live process state
                    let name_lower = name.to_lowercase();
                    let days_ago = find_recency_days(&name_lower, recent)
                        .or_else(|| find_recency_days(&id_lower, recent));
                    let is_running =
                        is_process_running(&name_lower, running) || is_process_running(&id_lower, running);
                    let recently_used = days_ago.is_some() || is_running;

                    if !include_by_recency(mode, is_running, days_ago) {
                        continue;
                    }

                    apps.push(AppEntry {
                        name,
                        id: Some(id),
                        version: pkg["Version"].as_str().map(|s| s.to_string()),
                        recently_used,
                        publisher: None,
                    });
                }
            }
        }
    }

    apps
}

// ─────────────────────────────────────────
//  Installed Programs Registry (ARP) — supplemental app data
// ─────────────────────────────────────────

fn month_from_abbr(abbr: &str) -> Option<u32> {
    match abbr.to_lowercase().as_str() {
        "jan" => Some(1),
        "feb" => Some(2),
        "mar" => Some(3),
        "apr" => Some(4),
        "may" => Some(5),
        "jun" => Some(6),
        "jul" => Some(7),
        "aug" => Some(8),
        "sep" => Some(9),
        "oct" => Some(10),
        "nov" => Some(11),
        "dec" => Some(12),
        _ => None,
    }
}

fn days_since(d: NaiveDate) -> f64 {
    let today = Utc::now().date_naive();
    today.signed_duration_since(d).num_days() as f64
}

// ARP's InstallDate field has no fixed format. We've seen at least three:
//   "20260628"                     (YYYYMMDD)
//   "2026/ 6/ 4"                   (slashed, irregular spacing)
//   "Sun Jul 14 00:44:14 EDT 2024" (full unix-style timestamp string)
// Only day-level precision matters for recency banding, so we don't
// bother parsing time-of-day or timezone for the third format.
fn parse_arp_date(raw: &str) -> Option<f64> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }

    // Format 1: YYYYMMDD
    if let Ok(d) = NaiveDate::parse_from_str(raw, "%Y%m%d") {
        return Some(days_since(d));
    }

    // Format 2: "YYYY/ M/ D" — strip spaces first
    let normalized: String = raw.chars().filter(|c| !c.is_whitespace()).collect();
    if let Ok(d) = NaiveDate::parse_from_str(&normalized, "%Y/%m/%d") {
        return Some(days_since(d));
    }

    // Format 3: "Sun Jul 14 00:44:14 EDT 2024" — token-split rather than
    // regex, since this project has deliberately avoided adding the regex
    // crate for one-off extractions like this.
    let tokens: Vec<&str> = raw.split_whitespace().collect();
    if tokens.len() >= 5 {
        let month = month_from_abbr(tokens[1]);
        let day = tokens[2].parse::<u32>().ok();
        let year = tokens.last().and_then(|y| y.parse::<i32>().ok());

        if let (Some(m), Some(d), Some(y)) = (month, day, year) {
            if let Some(date) = NaiveDate::from_ymd_opt(y, m, d) {
                return Some(days_since(date));
            }
        }
    }

    None
}

fn get_arp_apps() -> Vec<ArpAppEntry> {
    println!("  Checking installed-programs registry (ARP)...");

    let ps_script = r#"
Get-ItemProperty HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*, HKLM:\Software\Wow6432Node\Microsoft\Windows\CurrentVersion\Uninstall\* -ErrorAction SilentlyContinue |
    Where-Object { $_.DisplayName -and $_.SystemComponent -ne 1 } |
    Select-Object DisplayName, DisplayVersion, InstallDate, Publisher |
    ConvertTo-Json
"#;

    let output = Command::new("powershell")
        .args(["-NoProfile", "-Command", ps_script])
        .output();

    let output = match output {
        Ok(o) => o,
        Err(e) => {
            eprintln!("  Failed to run ARP scan: {}", e);
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
            eprintln!("  Failed to parse ARP JSON: {}", e);
            return vec![];
        }
    };

    let items: Vec<&serde_json::Value> = if json.is_array() {
        json.as_array().unwrap().iter().collect()
    } else {
        vec![&json]
    };

    let mut apps = Vec::new();

    for item in items {
        let name = match item["DisplayName"].as_str() {
            Some(n) if !n.trim().is_empty() => n.to_string(),
            _ => continue,
        };
        let version = item["DisplayVersion"].as_str().map(|s| s.to_string());
        let publisher = item["Publisher"].as_str().map(|s| s.to_string());
        let install_date_raw = item["InstallDate"].as_str().map(|s| s.to_string());
        let days_ago = install_date_raw.as_deref().and_then(parse_arp_date);

        apps.push(ArpAppEntry {
            name,
            version,
            publisher,
            install_date_raw,
            days_ago,
        });
    }

    apps
}

fn normalize_name(s: &str) -> String {
    s.to_lowercase()
        .chars()
        .filter(|c| c.is_alphanumeric())
        .collect()
}

fn merge_arp_into_apps(
    apps: &mut Vec<AppEntry>,
    arp_apps: Vec<ArpAppEntry>,
    mode: &str,
    recent: &HashMap<String, f64>,
    running: &HashSet<String>,
) {
    let existing_normalized: Vec<String> = apps.iter().map(|a| normalize_name(&a.name)).collect();

    let mut added = 0;

    for arp_app in arp_apps {
        let arp_norm = normalize_name(&arp_app.name);
        if arp_norm.is_empty() {
            continue;
        }

        let already_covered = existing_normalized
            .iter()
            .any(|existing| existing.contains(&arp_norm) || arp_norm.contains(existing));

        if already_covered {
            continue;
        }

        let name_lower = arp_app.name.to_lowercase();
        let days_ago = find_recency_days(&name_lower, recent);
        let is_running = is_process_running(&name_lower, running);

        if !include_by_recency(mode, is_running, days_ago) {
            continue;
        }

        apps.push(AppEntry {
            name: arp_app.name,
            id: None,
            version: arp_app.version,
            recently_used: days_ago.is_some() || is_running,
            publisher: arp_app.publisher,
        });
        added += 1;
    }

    println!("  ARP added {} apps not found via winget", added);
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
    let running = get_running_process_names();
    println!("  Found {} currently running process(es)", running.len());

    let mut apps = get_installed_apps(&mode, &recent, &running);
    if apps.is_empty() && mode == "quick" {
        println!("  Quick mode found no apps (Prefetch unavailable) — falling back to standard...");
        apps = get_installed_apps("standard", &recent, &running);
    }
    println!("  Found {} apps to check", apps.len());

    let arp_apps = get_arp_apps();
    merge_arp_into_apps(&mut apps, arp_apps, &mode, &recent, &running);
    println!("  {} total apps after ARP merge", apps.len());

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn standard_threshold_is_60_days_for_net_and_display() {
        assert_eq!(standard_threshold_days("Net"), 60.0);
        assert_eq!(standard_threshold_days("Display"), 60.0);
    }

    #[test]
    fn standard_threshold_is_14_days_for_other_device_classes() {
        for class in ["Camera", "HIDClass", "MEDIA", "Biometric", "SmartCardReader", "Printer"] {
            assert_eq!(standard_threshold_days(class), 14.0);
        }
    }

    #[test]
    fn standard_threshold_split_matches_a_dock_vs_a_webcam() {
        // A Net-class device (e.g. a dock's Ethernet adapter) last used 40
        // days ago should still be included in Standard mode...
        let net_days_ago = Some(40.0);
        assert!(net_days_ago.map_or(true, |d| d <= standard_threshold_days("Net")));

        // ...while a Camera-class device last used 20 days ago should not.
        let camera_days_ago = Some(20.0);
        assert!(!camera_days_ago.map_or(true, |d| d <= standard_threshold_days("Camera")));
    }
}
