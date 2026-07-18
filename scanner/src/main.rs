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
    // --- Observed Environment (new this pass) ---
    // Durable environmental observations, not derived conclusions — see
    // CLAUDE.md, Observed Environment milestone. The scanner reports these
    // raw; nothing here labels the machine "a laptop" or "a gaming PC" —
    // that interpretation belongs to the assessment layer, same boundary
    // already established for Guidance Signals.
    //
    // Strongest single indicator that the current machine is portable.
    // Deliberately a plain bool (not Option<bool>) per explicit scope: a
    // total Win32_Battery query failure is a genuinely rare edge case here,
    // unlike UserAssist's "never launched via Explorer" scenario, which is
    // the common case, not the rare one that justified None there.
    battery_present: bool,
    // Raw Win32_Processor.Manufacturer string ("GenuineIntel"/"AuthenticAMD"/
    // etc.) — not parsed or normalized from the cpu name. Deliberately not
    // reduced to a friendly "Intel"/"AMD"/"Qualcomm" label here: that string
    // normalization is exactly the kind of interpretation this milestone
    // draws the line at leaving to the assessment layer.
    cpu_vendor: Option<String>,
    // Derived from a count of real (non-placeholder) video controllers, not
    // from any vendor-name pattern — see get_system_info() for why. A plain
    // bool for the same reason battery_present is.
    discrete_gpu_present: bool,
    // Every distinct real AdapterCompatibility string observed across all
    // video controllers, not an attempt to label which one is "the discrete
    // card" specifically — see get_system_info()'s doc comment for why that
    // attribution was deliberately not attempted.
    gpu_vendors: Vec<String>,
    // Win32_ComputerSystem.PartOfDomain, nothing else — no domain name, no
    // organization, no tenant. A plain bool, same reasoning as battery_present.
    domain_joined: bool,
    // Registry EditionID (e.g. "Professional", "Core", "Enterprise") — weak,
    // corroborating evidence only, not meant to drive anything on its own.
    windows_edition: Option<String>,
    // Raw Win32_ComputerSystem.Manufacturer/Model — reported, not interpreted.
    system_manufacturer: Option<String>,
    system_model: Option<String>,
    // Raw Win32_BaseBoard.Manufacturer/Product — reported, not interpreted.
    motherboard_manufacturer: Option<String>,
    motherboard_product: Option<String>,
}

#[derive(Serialize, Deserialize, Debug)]
struct AppEntry {
    name: String,
    id: Option<String>,
    version: Option<String>,
    recently_used: bool,
    publisher: Option<String>,
    // Which collector found this app ("winget" | "arp" | "running-process" |
    // "appx") — free at construction time, previously discarded for the
    // original two sources. Lets the server weight winget's exact-ID matches
    // higher than ARP's fuzzy DisplayName matches if it ever needs to.
    discovery_source: String,
    // --- Guidance Signals ---
    // Relevance evidence for a future Workspace to weigh, not a compatibility
    // or recommendation determination on their own — this scanner pass only
    // collects and forwards them; nothing here changes classifyApps()'s score.
    is_running: bool,
    is_startup: bool,
    has_start_menu_entry: bool,
    // Pinning is a deliberate user action, not incidental presence — one of
    // the strongest cheap importance signals available (see CLAUDE.md,
    // Assessment levels). Taskbar only, not Start pinning: Start's pinned
    // layout on Windows 11 is stored in an undocumented binary blob with no
    // stable, simple read path; the taskbar's legacy .lnk-folder mechanism
    // is still functional and trivial to enumerate the same way Start Menu
    // shortcuts already are.
    is_pinned_taskbar: bool,
    // UserAssist (Explorer's own launch tracker) — see CLAUDE.md, UserAssist
    // Enrichment milestone. Raw, uninterpreted observations: launch_count is
    // the number of deliberate (non-automatic) launches Explorer recorded;
    // days_since_last_launch is a relative age already computed here, never
    // an exact timestamp. None means no UserAssist evidence was found for
    // this app — missing evidence, not evidence of zero use (it may simply
    // never have been launched via Explorer/Start/taskbar/search, or
    // UserAssist may not track this particular app at all). Deliberately
    // NOT reduced to a band ("frequent"/"occasional") here — that
    // interpretation belongs to the assessment layer, which should be free
    // to change its thresholds without a new scanner release.
    launch_count: Option<u32>,
    days_since_last_launch: Option<u32>,
    // Experimental — see CLAUDE.md, UserAssist Enrichment milestone, Focus
    // Fields addendum. Only ever populated from UserAssist's direct-.exe
    // GUID (real-data verification found the shortcut-GUID entries
    // unreliable at these offsets). Raw, un-interpreted, not wired into
    // any scoring/importance logic yet — preserved because collection is
    // cheap and privacy-conscious, per this milestone's guiding brief, not
    // because the assessment layer currently uses it.
    focus_count: Option<u32>,
    focus_time_ms: Option<u32>,
    // Default-handler ("Environment Integration") evidence — see CLAUDE.md,
    // Default-Handler Evidence addendum. Scoped to protocol handlers only
    // (http/https/mailto); file-extension UserChoice entries were
    // investigated and found consistently empty on real test hardware, so
    // that half of the original idea isn't implemented — reported as a
    // limitation, not guessed at. default_handler_count is how many of the
    // checked protocols resolved to this app; categories is a short,
    // deliberately coarse list ("browser"/"mail"), never a raw ProgId or
    // extension. None means no checked protocol currently defaults to this
    // app — missing evidence, not evidence the app is unused.
    default_handler_count: Option<u32>,
    default_handler_categories: Option<Vec<String>>,
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
    // Only ever populated by get_printers() (network vs. local printer, via
    // port-name check) — always false for get_devices() rows. A Net-class
    // USB-Ethernet/WiFi adapter is already unambiguously labeled via `class`,
    // so this field is intentionally not wired up for non-printer devices;
    // it's not a bug, just a printer-specific field with a generic name.
    is_network: bool,
    // Free on the base Get-PnpDevice object (no extra per-device API call) —
    // populated in both Quick and Standard/Full. None for printers (not
    // sourced from Get-PnpDevice).
    manufacturer: Option<String>,
    // Driver service/INF name — also free on the base object. Populated
    // alongside manufacturer.
    driver_service: Option<String>,
    // Requires a Get-PnpDeviceProperty call, so only collected in
    // Standard/Full mode (matches the existing arrival/removal-date cost
    // tier) — Quick stays presence-only by design. "Microsoft" here is
    // corroborating evidence a device relies on Windows' inbox driver stack;
    // a vendor name means it doesn't. None when not looked up.
    driver_provider: Option<String>,
}

#[derive(Serialize, Deserialize, Debug)]
struct ScanPayload {
    scan_mode: String,
    scanned_at: String,
    session_id: Option<String>,
    system: SystemInfo,
    apps: Vec<AppEntry>,
    devices: Vec<DeviceEntry>,
    // Added now, before more scanner generations ship without one — lets the
    // server eventually distinguish "old scanner, known shape" from
    // "malformed payload" instead of relying on optional-field tolerance
    // forever. Bump only on an actual breaking shape change, not every field
    // addition (additive fields stay compatible via serde's Option handling).
    payload_version: u32,
    scanner_version: String,
    // Guidance Signals (new this pass) — apps observed running or AppX-packaged
    // that don't match anything already in `apps` (via the same fuzzy
    // name-containment check used for ARP merging). Deliberately kept separate
    // from `apps` rather than merged in: the server never feeds these into
    // classifyApps(), so they cannot affect the readiness score, by
    // construction rather than by convention.
    unlisted_apps: Vec<AppEntry>,
    appx_apps: Vec<AppEntry>,
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

    // Architecture — check PROCESSOR_ARCHITEW6432 first, since it reflects the
    // true native OS architecture even when this process is running under
    // emulation (e.g. this x64 exe on a real ARM64 machine). Windows only sets
    // this variable when emulation is active, so falling back to
    // PROCESSOR_ARCHITECTURE on non-emulated machines is correct.
    let arch = std::env::var("PROCESSOR_ARCHITEW6432")
        .or_else(|_| std::env::var("PROCESSOR_ARCHITECTURE"))
        .unwrap_or_else(|_| "Unknown".to_string());

    let is_arm = arch.to_lowercase().contains("arm");

    // CPU name/vendor, RAM, battery presence, GPU count/vendors, domain
    // membership, Windows edition, and system/motherboard identity are all
    // collected in one consolidated Get-CimInstance script instead of one
    // PowerShell process per field — replaces the old separate Get-WmiObject
    // calls for CPU/RAM, matching the run_powershell_json() pattern every
    // other collector in this file already uses (PowerShell boilerplate
    // deduplication, Scanner Stabilization milestone).
    let ps_script = r#"
$cs = Get-CimInstance -ClassName Win32_ComputerSystem -ErrorAction SilentlyContinue
$cpu = Get-CimInstance -ClassName Win32_Processor -ErrorAction SilentlyContinue | Select-Object -First 1
$battery = Get-CimInstance -ClassName Win32_Battery -ErrorAction SilentlyContinue
$board = Get-CimInstance -ClassName Win32_BaseBoard -ErrorAction SilentlyContinue
$edition = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' -ErrorAction SilentlyContinue).EditionID

# Microsoft's own generic fallback drivers aren't real physical adapters —
# the same "is this a real device, not a placeholder" filtering the scanner
# already applies elsewhere (e.g. SW\-prefix virtual-device exclusion).
# Excluding them keeps GpuCount/GpuVendors meaningful instead of always
# reporting at least one phantom entry.
$genericGpuNames = @('Microsoft Basic Display Adapter', 'Microsoft Basic Render Driver')
$gpuControllers = @(Get-CimInstance -ClassName Win32_VideoController -ErrorAction SilentlyContinue | Where-Object { $_.Name -and ($genericGpuNames -notcontains $_.Name) })
$gpuVendors = @($gpuControllers | Select-Object -ExpandProperty AdapterCompatibility -Unique | Where-Object { $_ })

[PSCustomObject]@{
    RamBytes = $cs.TotalPhysicalMemory
    SystemManufacturer = $cs.Manufacturer
    SystemModel = $cs.Model
    DomainJoined = [bool]$cs.PartOfDomain
    CpuName = $cpu.Name
    CpuVendor = $cpu.Manufacturer
    BatteryPresent = [bool]$battery
    GpuCount = $gpuControllers.Count
    GpuVendors = $gpuVendors
    MotherboardManufacturer = $board.Manufacturer
    MotherboardProduct = $board.Product
    WindowsEdition = $edition
} | ConvertTo-Json -Compress
"#;

    let json = run_powershell_json(ps_script, "system environment info");

    let cpu = json
        .as_ref()
        .and_then(|j| j["CpuName"].as_str())
        .unwrap_or("Unknown")
        .to_string();
    let cpu_vendor = json
        .as_ref()
        .and_then(|j| j["CpuVendor"].as_str())
        .map(|s| s.to_string());
    let ram_bytes = json.as_ref().and_then(|j| j["RamBytes"].as_u64()).unwrap_or(0);
    let ram_gb = ram_bytes / 1_073_741_824;
    let battery_present = json
        .as_ref()
        .and_then(|j| j["BatteryPresent"].as_bool())
        .unwrap_or(false);
    let domain_joined = json
        .as_ref()
        .and_then(|j| j["DomainJoined"].as_bool())
        .unwrap_or(false);
    let windows_edition = json
        .as_ref()
        .and_then(|j| j["WindowsEdition"].as_str())
        .map(|s| s.to_string());
    let system_manufacturer = json
        .as_ref()
        .and_then(|j| j["SystemManufacturer"].as_str())
        .map(|s| s.to_string());
    let system_model = json
        .as_ref()
        .and_then(|j| j["SystemModel"].as_str())
        .map(|s| s.to_string());
    let motherboard_manufacturer = json
        .as_ref()
        .and_then(|j| j["MotherboardManufacturer"].as_str())
        .map(|s| s.to_string());
    let motherboard_product = json
        .as_ref()
        .and_then(|j| j["MotherboardProduct"].as_str())
        .map(|s| s.to_string());

    let gpu_count = json.as_ref().and_then(|j| j["GpuCount"].as_i64()).unwrap_or(0);
    let discrete_gpu_present = gpu_count > 1;

    // GpuVendors is written with @() in the PowerShell script specifically so
    // it survives ConvertTo-Json as a JSON array even with 0 or 1 elements —
    // but both shapes are handled defensively here anyway, the same
    // "single item can still collapse to a bare scalar" tolerance
    // json_as_items() already applies to top-level PowerShell JSON output.
    let gpu_vendors: Vec<String> = match json.as_ref().map(|j| &j["GpuVendors"]) {
        Some(v) if v.is_array() => v
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|x| x.as_str())
            .map(|s| s.to_string())
            .collect(),
        Some(v) if v.is_string() => vec![v.as_str().unwrap().to_string()],
        _ => vec![],
    };

    SystemInfo {
        os_version,
        cpu,
        ram_gb,
        architecture: arch,
        is_arm,
        battery_present,
        cpu_vendor,
        discrete_gpu_present,
        gpu_vendors,
        domain_joined,
        windows_edition,
        system_manufacturer,
        system_model,
        motherboard_manufacturer,
        motherboard_product,
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

// Application inventory is intentionally mode-agnostic — see the
// Assessment levels doc in CLAUDE.md. `winget export` and the ARP registry
// read are unconditional regardless of mode (confirmed: no mode-dependent
// enumeration cost exists for apps, only device history lookups have a real
// scan-time cost — see get_devices() below). Previously this function
// gated which already-discovered apps got pushed into the outgoing payload
// per mode; that's now the assessment layer's job (isLightPriorityApp() in
// assessment.js), operating on the full inventory the scanner always
// reports. days_ago/is_running/recently_used are still computed and
// attached to every app as enrichment — just no longer used to exclude one.

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
//  Shared PowerShell run/parse helpers
// ─────────────────────────────────────────

// Runs a PowerShell script expected to emit ConvertTo-Json output, returning
// None (with a logged reason) on process failure, empty output, or malformed
// JSON. `context` is only used for the log message, so each caller keeps its
// own distinct, useful error text instead of one generic one.
fn run_powershell_json(script: &str, context: &str) -> Option<serde_json::Value> {
    let output = Command::new("powershell")
        .args(["-NoProfile", "-Command", script])
        .output();

    let output = match output {
        Ok(o) => o,
        Err(e) => {
            eprintln!("  Failed to run {}: {}", context, e);
            return None;
        }
    };

    let json_text = String::from_utf8_lossy(&output.stdout);
    if json_text.trim().is_empty() {
        return None;
    }

    match serde_json::from_str(&json_text) {
        Ok(v) => Some(v),
        Err(e) => {
            eprintln!("  Failed to parse {} JSON: {}", context, e);
            None
        }
    }
}

// ConvertTo-Json emits a bare object (not an array) when PowerShell only
// found one result — this normalizes both shapes to a uniform item list.
fn json_as_items(json: &serde_json::Value) -> Vec<&serde_json::Value> {
    if json.is_array() {
        json.as_array().unwrap().iter().collect()
    } else {
        vec![json]
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
        Manufacturer = $_.Manufacturer
        Service = $_.Service
        DriverProvider = $null
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
    $driverProvider = (Get-PnpDeviceProperty -InstanceId $_.InstanceId -KeyName 'DEVPKEY_Device_DriverProvider' -ErrorAction SilentlyContinue).Data

    $arrivalDaysAgo = if ($arrival) { [math]::Round(((Get-Date) - $arrival).TotalDays, 1) } else { $null }
    $removalDaysAgo = if ($removal) { [math]::Round(((Get-Date) - $removal).TotalDays, 1) } else { $null }
    $recency = if ($removalDaysAgo -ne $null) { $removalDaysAgo } else { $arrivalDaysAgo }

    [PSCustomObject]@{
        Name = $_.FriendlyName
        Class = $_.Class
        VidPid = $vidPid
        IsPresent = $isPresent
        DaysAgo = $recency
        Manufacturer = $_.Manufacturer
        Service = $_.Service
        DriverProvider = $driverProvider
    }
} | ConvertTo-Json
"#
    };

    let json = match run_powershell_json(ps_script, "device scan") {
        Some(v) => v,
        None => return vec![],
    };

    let items = json_as_items(&json);

    // Group raw rows by VID/PID first, so we can pick the best
    // representative row per physical device before filtering by tier.
    struct RawDeviceRow {
        name: String,
        class: String,
        is_present: bool,
        days_ago: Option<f64>,
        manufacturer: Option<String>,
        service: Option<String>,
        driver_provider: Option<String>,
    }

    let mut grouped: HashMap<String, Vec<RawDeviceRow>> = HashMap::new();

    for item in items {
        let name = item["Name"]
            .as_str()
            .unwrap_or("Unknown Device")
            .to_string();
        let class = item["Class"].as_str().unwrap_or("Unknown").to_string();
        let vid_pid = item["VidPid"].as_str().unwrap_or("").to_string();
        let is_present = item["IsPresent"].as_bool().unwrap_or(false);
        let days_ago = item["DaysAgo"].as_f64();
        let manufacturer = item["Manufacturer"].as_str().map(|s| s.to_string());
        let service = item["Service"].as_str().map(|s| s.to_string());
        let driver_provider = item["DriverProvider"].as_str().map(|s| s.to_string());

        if vid_pid.is_empty() {
            continue;
        }

        grouped.entry(vid_pid).or_insert_with(Vec::new).push(RawDeviceRow {
            name,
            class,
            is_present,
            days_ago,
            manufacturer,
            service,
            driver_provider,
        });
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
            .find(|r| !is_generic_name(&r.name))
            .unwrap_or(&rows[0]);

        let name = best.name.clone();
        let manufacturer = best.manufacturer.clone();
        let driver_service = best.service.clone();
        let driver_provider = best.driver_provider.clone();

        // For classification, use the most conservative class seen across
        // ALL interfaces of this device — a composite device that includes
        // any sensitive interface (biometric/smart-card) should stay
        // flagged for review even if it also exposes a generic HID/media
        // interface elsewhere.
        let class = rows
            .iter()
            .map(|r| r.class.clone())
            .find(|c| review_classes.contains(&c.as_str()))
            .unwrap_or_else(|| best.class.clone());

        let is_present = rows.iter().any(|r| r.is_present);
        let days_ago =
            rows.iter()
                .filter_map(|r| r.days_ago)
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
                manufacturer,
                driver_service,
                driver_provider,
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

    let json = match run_powershell_json(ps_script, "printer scan") {
        Some(v) => v,
        None => return vec![],
    };

    let items = json_as_items(&json);

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
            manufacturer: None,
            driver_service: None,
            driver_provider: None,
        });
    }

    printers
}

// ─────────────────────────────────────────
//  Installed Apps via Winget
// ─────────────────────────────────────────

fn get_installed_apps(
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

                    // `winget export`'s JSON has no Publisher field, so this is a coarse
                    // hint derived from the ID's vendor segment (already split above),
                    // not a verified publisher — good enough to unblock the server's
                    // Microsoft-component noise filter, not for display as a fact.
                    let publisher_hint = parts.first().map(|p| p.to_string());

                    // Check recency via Prefetch mtime and live process state
                    let name_lower = name.to_lowercase();
                    let days_ago = find_recency_days(&name_lower, recent)
                        .or_else(|| find_recency_days(&id_lower, recent));
                    let is_running =
                        is_process_running(&name_lower, running) || is_process_running(&id_lower, running);
                    let recently_used = days_ago.is_some() || is_running;

                    apps.push(AppEntry {
                        name,
                        id: Some(id),
                        version: pkg["Version"].as_str().map(|s| s.to_string()),
                        recently_used,
                        publisher: publisher_hint,
                        discovery_source: "winget".to_string(),
                        is_running: false,
                        is_startup: false,
                        has_start_menu_entry: false,
                        is_pinned_taskbar: false,
                        launch_count: None,
                        days_since_last_launch: None,
                        focus_count: None,
                        focus_time_ms: None,
                        default_handler_count: None,
                        default_handler_categories: None,
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

// HKCU coverage catches per-user installs that never touch HKLM at all —
// developer tools installed without admin rights, and notably
// Chrome/Edge-installed PWAs, which register a per-user uninstall entry
// (Publisher containing "Google\Chrome" or "Microsoft\Edge") purely under
// HKCU. Confirmed on a real machine: a Chrome-installed PWA was completely
// invisible to this scanner before this change despite being genuinely
// installed and usable. No Wow6432Node equivalent needed for HKCU — that
// redirection only applies to HKLM (and HKCR) on 64-bit Windows, not to
// per-user hives.
fn get_arp_apps() -> Vec<ArpAppEntry> {
    println!("  Checking installed-programs registry (ARP)...");

    let ps_script = r#"
Get-ItemProperty HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*, HKLM:\Software\Wow6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*, HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\* -ErrorAction SilentlyContinue |
    Where-Object { $_.DisplayName -and $_.SystemComponent -ne 1 } |
    Select-Object DisplayName, DisplayVersion, InstallDate, Publisher |
    ConvertTo-Json
"#;

    let json = match run_powershell_json(ps_script, "ARP scan") {
        Some(v) => v,
        None => return vec![],
    };

    let items = json_as_items(&json);

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

        apps.push(AppEntry {
            name: arp_app.name,
            id: None,
            version: arp_app.version,
            recently_used: days_ago.is_some() || is_running,
            publisher: arp_app.publisher,
            discovery_source: "arp".to_string(),
            is_running: false,
            is_startup: false,
            has_start_menu_entry: false,
            is_pinned_taskbar: false,
            launch_count: None,
            days_since_last_launch: None,
            focus_count: None,
            focus_time_ms: None,
            default_handler_count: None,
            default_handler_categories: None,
        });
        added += 1;
    }

    println!("  ARP added {} apps not found via winget", added);
}

// ─────────────────────────────────────────
//  Guidance Signals — running apps, startup apps, launchability, AppX
//
//  Everything in this section is corroborating relevance evidence for a
//  future Workspace, not a compatibility or recommendation determination.
//  Privacy design, applied consistently across all four collectors below:
//  never capture full file paths (can reveal personal folder/username
//  structure) or window title text (can reveal document names, browser tab
//  content, conversation previews) — only vendor- or OS-authored labels
//  (process Description/Company, registry value names, shortcut filenames,
//  AppX package metadata), the same tier of information ARP/winget already
//  send today.
// ─────────────────────────────────────────

fn normalized_names(apps: &[AppEntry]) -> Vec<String> {
    apps.iter().map(|a| normalize_name(&a.name)).collect()
}

// Reuses the exact fuzzy substring-containment dedup already established for
// ARP merging — same tradeoffs already accepted, not a new matching strategy.
fn filter_unlisted(candidates: Vec<AppEntry>, known_normalized: &[String]) -> Vec<AppEntry> {
    candidates
        .into_iter()
        .filter(|c| {
            let cn = normalize_name(&c.name);
            !cn.is_empty()
                && !known_normalized
                    .iter()
                    .any(|k| k.contains(cn.as_str()) || cn.contains(k.as_str()))
        })
        .collect()
}

// Applies all three Guidance Signals to a list of already-constructed
// AppEntry rows in one pass, so the matching logic lives in exactly one
// place regardless of which list (main apps, unlisted, AppX) it runs
// against.
fn apply_signals(
    apps: &mut [AppEntry],
    running: &HashSet<String>,
    startup_names: &[String],
    start_menu_names: &[String],
    pinned_names: &[String],
    userassist: &[UserAssistEvidence],
    default_handlers: &[DefaultHandlerEvidence],
) {
    for app in apps.iter_mut() {
        if !app.is_running {
            let name_lower = app.name.to_lowercase();
            let id_lower = app.id.as_deref().unwrap_or("").to_lowercase();
            app.is_running =
                is_process_running(&name_lower, running) || is_process_running(&id_lower, running);
        }

        let norm = normalize_name(&app.name);
        if norm.is_empty() {
            continue;
        }

        app.is_startup = startup_names.iter().any(|s| {
            let sn = normalize_name(s);
            !sn.is_empty() && (sn.contains(norm.as_str()) || norm.contains(sn.as_str()))
        });
        app.has_start_menu_entry = start_menu_names.iter().any(|s| {
            let sn = normalize_name(s);
            !sn.is_empty() && (sn.contains(norm.as_str()) || norm.contains(sn.as_str()))
        });
        app.is_pinned_taskbar = pinned_names.iter().any(|s| {
            let sn = normalize_name(s);
            !sn.is_empty() && (sn.contains(norm.as_str()) || norm.contains(sn.as_str()))
        });

        // UserAssist: prefer an exact PackageFamilyName match (AppX apps
        // already carry this as `id`, see get_appx_apps()) over the fuzzy
        // basename match everything else falls back to — an id match is
        // unambiguous, a name match carries the same accepted imprecision
        // as every other Guidance Signal above. Multiple raw UserAssist
        // records can legitimately match one app (direct-exe launches and
        // shortcut launches are tracked under separate GUIDs) — counts sum,
        // and the most recent (smallest) days-since-last-launch wins, the
        // same "most informative evidence wins" fallback already used for
        // device recency (IsPresent OR LastRemovalDate OR LastArrivalDate).
        let app_id_lower = app.id.as_deref().unwrap_or("").to_lowercase();
        let mut matches: Vec<&UserAssistEvidence> = if app_id_lower.is_empty() {
            vec![]
        } else {
            userassist
                .iter()
                .filter(|e| e.is_package && e.key.to_lowercase() == app_id_lower)
                .collect()
        };
        if matches.is_empty() {
            matches = userassist
                .iter()
                .filter(|e| {
                    !e.is_package && (e.key.contains(norm.as_str()) || norm.contains(e.key.as_str()))
                })
                .collect();
        }
        if !matches.is_empty() {
            app.launch_count = Some(matches.iter().map(|e| e.launch_count).sum());
            app.days_since_last_launch = matches.iter().filter_map(|e| e.days_since_last_launch).min();
            let focus_counts: Vec<u32> = matches.iter().filter_map(|e| e.focus_count).collect();
            if !focus_counts.is_empty() {
                app.focus_count = Some(focus_counts.iter().sum());
            }
            let focus_times: Vec<u32> = matches.iter().filter_map(|e| e.focus_time_ms).collect();
            if !focus_times.is_empty() {
                app.focus_time_ms = Some(focus_times.iter().sum());
            }
        }

        // Default-handler evidence: identical exact-id-then-fuzzy-name
        // matching contract as UserAssist above, reused rather than
        // reinvented. A protocol like http/https/mailto only ever resolves
        // to one ProgId at a time, so at most one match is expected here in
        // practice — the same "sum count / union categories" merge is used
        // anyway for consistency with every other evidence source.
        let dh_matches: Vec<&DefaultHandlerEvidence> = if !app_id_lower.is_empty() {
            let exact: Vec<&DefaultHandlerEvidence> = default_handlers
                .iter()
                .filter(|e| e.is_package && e.key.to_lowercase() == app_id_lower)
                .collect();
            if !exact.is_empty() {
                exact
            } else {
                default_handlers
                    .iter()
                    .filter(|e| !e.is_package && (e.key.contains(norm.as_str()) || norm.contains(e.key.as_str())))
                    .collect()
            }
        } else {
            default_handlers
                .iter()
                .filter(|e| !e.is_package && (e.key.contains(norm.as_str()) || norm.contains(e.key.as_str())))
                .collect()
        };
        if !dh_matches.is_empty() {
            app.default_handler_count = Some(dh_matches.iter().map(|e| e.count).sum());
            let mut categories: Vec<String> = Vec::new();
            for e in &dh_matches {
                for c in &e.categories {
                    if !categories.contains(c) {
                        categories.push(c.clone());
                    }
                }
            }
            app.default_handler_categories = Some(categories);
        }
    }
}

// WS1: apps with a visible foreground window right now — the strongest cheap
// signal that a process is a real, interactive application rather than a
// background service/helper. This is also how portable/sideloaded software
// (no installer, no ARP/winget registration) gets discovered at all: if it's
// not already in `apps`, this is the only source that can ever see it.
//
// MainWindowTitle is used purely as a PowerShell-side filter — it is never
// selected into the object returned to Rust, so its content (which can
// contain document names, browser tab titles, etc.) never leaves the
// machine. We want to know an app is running, not what someone is doing
// in it.
fn get_running_gui_apps() -> Vec<AppEntry> {
    let ps_script = r#"
Get-Process | Where-Object { $_.MainWindowTitle } | ForEach-Object {
    [PSCustomObject]@{
        ProcessName = $_.ProcessName
        Description = $_.Description
        Company = $_.Company
    }
} | ConvertTo-Json
"#;

    let json = match run_powershell_json(ps_script, "running application scan") {
        Some(v) => v,
        None => return vec![],
    };

    let mut seen = HashSet::new();
    let mut apps = Vec::new();

    for item in json_as_items(&json) {
        let process_name = item["ProcessName"].as_str().unwrap_or("").to_string();
        if process_name.is_empty() || process_name.eq_ignore_ascii_case("ngpcx-scanner") {
            continue; // skip malformed rows and this scanner's own console window
        }
        if !seen.insert(process_name.clone()) {
            continue; // one exe can own several windows (e.g. a browser's tabs)
        }

        let description = item["Description"]
            .as_str()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let company = item["Company"]
            .as_str()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let name = description.unwrap_or_else(|| process_name.clone());

        apps.push(AppEntry {
            name,
            id: None,
            version: None,
            recently_used: true,
            publisher: company,
            discovery_source: "running-process".to_string(),
            is_running: true,
            is_startup: false,
            has_start_menu_entry: false,
            is_pinned_taskbar: false,
            launch_count: None,
            days_since_last_launch: None,
            focus_count: None,
            focus_time_ms: None,
            default_handler_count: None,
            default_handler_categories: None,
        });
    }

    apps
}

// WS2: Run-key value NAMES only — deliberately not the command strings those
// values hold, which are full file paths. Value names are vendor-authored
// labels (e.g. "OneDriveSetup", "Discord"), the same privacy tier as an ARP
// DisplayName. Known, accepted limitation shared with every tool that reads
// these keys: entries can go stale if a vendor's uninstaller doesn't clean
// up after itself, so this is corroborating evidence, not a live guarantee.
fn get_startup_names() -> Vec<String> {
    let ps_script = r#"
$keys = @(
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run',
    'HKLM:\Software\Microsoft\Windows\CurrentVersion\Run',
    'HKLM:\Software\Wow6432Node\Microsoft\Windows\CurrentVersion\Run'
)
$names = foreach ($key in $keys) {
    (Get-Item -Path $key -ErrorAction SilentlyContinue).Property
}
$names | Sort-Object -Unique | ForEach-Object { [PSCustomObject]@{ Name = $_ } } | ConvertTo-Json
"#;

    let json = match run_powershell_json(ps_script, "startup app scan") {
        Some(v) => v,
        None => return vec![],
    };

    json_as_items(&json)
        .into_iter()
        .filter_map(|item| item["Name"].as_str().map(|s| s.to_string()))
        .collect()
}

// WS3: Start Menu shortcut base filenames only — never resolves what the
// shortcut actually points at, so this is purely "does a launch entry exist
// with roughly this name," not a claim about the target executable.
// Deliberately scoped to Start Menu (both all-users and current-user), not
// the Desktop — Start Menu entries are installer-created and reasonably
// curated; Desktop icons are much noisier and user-arranged.
fn get_start_menu_names() -> Vec<String> {
    let ps_script = r#"
$paths = @(
    (Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs'),
    (Join-Path $env:AppData 'Microsoft\Windows\Start Menu\Programs')
) | Where-Object { Test-Path $_ }

Get-ChildItem -Path $paths -Filter *.lnk -Recurse -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty BaseName -Unique |
    ForEach-Object { [PSCustomObject]@{ Name = $_ } } |
    ConvertTo-Json
"#;

    let json = match run_powershell_json(ps_script, "Start Menu scan") {
        Some(v) => v,
        None => return vec![],
    };

    json_as_items(&json)
        .into_iter()
        .filter_map(|item| item["Name"].as_str().map(|s| s.to_string()))
        .collect()
}

// Taskbar pinning is a deliberate user action — one of the strongest cheap
// importance signals available, arguably stronger than is_running (which
// only proves "happened to be open right now," not "core to my workflow").
// The legacy .lnk-folder mechanism this reads is undocumented as a stable
// API and Windows 11 has been migrating taskbar customization to newer
// backends over time, so this may stop finding anything on some future
// build — verified working on this real Windows 11 install today, and the
// failure mode if it ever stops is an empty list (missing evidence),
// exactly the safe direction per this milestone's own guiding philosophy.
// Same "base filename only, never resolves the shortcut target" discipline
// as get_start_menu_names().
fn get_taskbar_pinned_names() -> Vec<String> {
    let ps_script = r#"
$path = Join-Path $env:AppData 'Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar'
if (-not (Test-Path $path)) { '[]'; exit }

Get-ChildItem -Path $path -Filter *.lnk -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty BaseName -Unique |
    ForEach-Object { [PSCustomObject]@{ Name = $_ } } |
    ConvertTo-Json
"#;

    let json = match run_powershell_json(ps_script, "taskbar pin scan") {
        Some(v) => v,
        None => return vec![],
    };

    json_as_items(&json)
        .into_iter()
        .filter_map(|item| item["Name"].as_str().map(|s| s.to_string()))
        .collect()
}

// One decoded, already-aggregated UserAssist observation, internal to the
// scanner process only (never serialized/sent as-is) — `key`/`is_package`
// tell apply_signals() whether to match it against an AppX PackageFamilyName
// (exact) or fall back to the fuzzy basename matching every other Guidance
// Signal already uses. focus_count/focus_time_ms are experimental (see
// get_userassist_data()'s doc comment) and only ever populated from
// direct-.exe-GUID records — real-data verification found the shortcut-GUID
// entries carry near-zero, non-representative values at these offsets.
struct UserAssistEvidence {
    key: String,
    is_package: bool,
    launch_count: u32,
    days_since_last_launch: Option<u32>,
    focus_count: Option<u32>,
    focus_time_ms: Option<u32>,
}

// UserAssist — Windows Explorer's own internal launch tracker. Undocumented
// by Microsoft but stable since Vista; see CLAUDE.md, UserAssist Enrichment
// milestone, for the research this is based on. Unlike Prefetch, UserAssist
// specifically excludes non-interactive launches — real testing (and this
// codebase's own research pass) confirmed Startup-folder and Scheduled-Task
// launches consistently register a zero run count even though the program
// genuinely ran. That makes a nonzero run count here the one signal in this
// codebase that corroborates a *deliberate, Explorer-driven* launch, rather
// than mere presence or automatic execution — entries with a zero count are
// discarded entirely below, not treated as weak evidence.
//
// Two GUIDs matter for Windows 10/11 (a handful of older folder-scoped GUIDs
// from the XP/7 era don't carry meaningful execution data today and aren't
// read here):
//   CEBFF5CD-ACE2-4F4F-9178-9926F41749EA — direct .exe launches
//   F4E57C4B-2036-45F0-A9AB-443BCFE33D9F — shortcut/.lnk launches (Start
//     Menu, taskbar, search), including AppX/UWP apps, which appear here as
//     AUMIDs ("PackageFamilyName!AppId") rather than file paths.
//
// Privacy/precision discipline: value names are ROT13-decoded here (a
// documented, trivial reversal, not real obfuscation) purely to extract a
// program name/PackageFamilyName — the same tier of information ARP/winget
// already send, never a full path beyond what's needed to find the last
// path segment. The last-run FILETIME is converted to a relative day count
// inside this PowerShell script and immediately discarded; only the
// relative age ever reaches Rust, and only the relative age is ever sent to
// the server — exact timestamps never leave this function.
//
// `UEME_CTLSESSION` (and the `UEME_CTL*` family generally) is a well-known
// Explorer internal session-bookkeeping entry, not an application — verified
// directly against this machine's own registry: it carries a ~1.6KB value
// (vs. 72 bytes for a real app entry) and a nonsense pre-1970 "last run"
// date when parsed as a normal record. Excluded by name before any byte
// parsing runs, not silently absorbed and hoped to never fuzzy-match.
//
// Focus Count (offset 8) / Focus Time in ms (offset 12) — added as
// EXPERIMENTAL raw evidence after direct verification against this
// machine's real data: values from the direct-.exe GUID were plausible
// (e.g. a browser genuinely used today showing ~45 minutes of accumulated
// focus time) and internally consistent with which apps were actually used.
// Values from the shortcut-launch GUID were NOT — near-zero/nonsensical
// even for apps with a real, same-day launch recorded on their direct-.exe
// counterpart — so this scanner only ever populates focus fields from the
// direct-.exe GUID; shortcut-GUID records never contribute focus data,
// matching this milestone's "report rather than invent semantics" brief.
// Neither field is wired into scoring/importance anywhere yet — see
// CLAUDE.md, UserAssist Enrichment milestone, Focus Fields addendum.
fn get_userassist_data() -> Vec<UserAssistEvidence> {
    let ps_script = r#"
$guids = @(
    @{ Id = 'CEBFF5CD-ACE2-4F4F-9178-9926F41749EA'; IsDirectExe = $true },
    @{ Id = 'F4E57C4B-2036-45F0-A9AB-443BCFE33D9F'; IsDirectExe = $false }
)
$rot13 = {
    param($s)
    -join ($s.ToCharArray() | ForEach-Object {
        if ($_ -cmatch '[a-zA-Z]') {
            $base = if ([char]::IsUpper($_)) { 65 } else { 97 }
            [char]((([int]$_ - $base + 13) % 26) + $base)
        } else { $_ }
    })
}

$results = foreach ($guidInfo in $guids) {
    $path = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\UserAssist\{$($guidInfo.Id)}\Count"
    $key = Get-Item -Path $path -ErrorAction SilentlyContinue
    if (-not $key) { continue }
    foreach ($valueName in $key.GetValueNames()) {
        if (-not $valueName -or $valueName -like 'UEME_CTL*') { continue }
        $bytes = $key.GetValue($valueName)
        if ($bytes -isnot [byte[]] -or $bytes.Length -lt 68) { continue }
        $runCount = [BitConverter]::ToUInt32($bytes, 4)
        if ($runCount -lt 1) { continue }
        $decodedName = & $rot13 $valueName
        $lastRunTicks = [BitConverter]::ToInt64($bytes, 60)
        $daysSince = $null
        if ($lastRunTicks -gt 0) {
            try {
                $lastRunUtc = [DateTime]::FromFileTimeUtc($lastRunTicks)
                $daysSince = [int]([DateTime]::UtcNow - $lastRunUtc).TotalDays
                if ($daysSince -lt 0) { $daysSince = 0 }
            } catch { $daysSince = $null }
        }
        $focusCount = $null
        $focusTimeMs = $null
        if ($guidInfo.IsDirectExe) {
            $focusCount = [BitConverter]::ToUInt32($bytes, 8)
            $focusTimeMs = [BitConverter]::ToUInt32($bytes, 12)
        }
        [PSCustomObject]@{
            Name = $decodedName
            RunCount = $runCount
            DaysSinceLastLaunch = $daysSince
            FocusCount = $focusCount
            FocusTimeMs = $focusTimeMs
        }
    }
}
$results | ConvertTo-Json
"#;

    let json = match run_powershell_json(ps_script, "UserAssist scan") {
        Some(v) => v,
        None => return vec![],
    };

    // Aggregate raw per-value records into one evidence entry per app: both
    // GUIDs above can carry launch/recency data for the same app, so counts
    // sum and the more recent (smaller) days-since-last-launch wins — same
    // "most informative evidence wins" fallback already used for device
    // recency. Focus fields only ever arrive from direct-.exe records (see
    // doc comment above), so they simply sum/take-min across whatever
    // direct-.exe records matched — never diluted by shortcut-GUID noise.
    struct Agg {
        launch_count: u32,
        days_since_last_launch: Option<u32>,
        focus_count: Option<u32>,
        focus_time_ms: Option<u32>,
    }
    let mut aggregated: HashMap<(String, bool), Agg> = HashMap::new();

    for item in json_as_items(&json) {
        let decoded = match item["Name"].as_str() {
            Some(n) if !n.trim().is_empty() => n,
            _ => continue,
        };
        let run_count = item["RunCount"].as_u64().unwrap_or(0) as u32;
        if run_count < 1 {
            continue;
        }
        let days_since = item["DaysSinceLastLaunch"].as_u64().map(|d| d as u32);
        let focus_count = item["FocusCount"].as_u64().map(|d| d as u32);
        let focus_time_ms = item["FocusTimeMs"].as_u64().map(|d| d as u32);

        // AppX/UWP entries are AUMIDs ("PackageFamilyName!AppId"); everything
        // else is a full path. Reduce each to the same key shape the rest of
        // apply_signals() already uses: the exact PackageFamilyName for
        // AppX, or the normalized basename for a real path (fuzzy match).
        let (key, is_package) = match decoded.find('!') {
            Some(bang) => (decoded[..bang].to_string(), true),
            None => {
                let basename = decoded.rsplit(['\\', '/']).next().unwrap_or(decoded);
                (normalize_name(basename), false)
            }
        };
        if key.is_empty() {
            continue;
        }

        let entry = aggregated.entry((key, is_package)).or_insert(Agg {
            launch_count: 0,
            days_since_last_launch: None,
            focus_count: None,
            focus_time_ms: None,
        });
        entry.launch_count += run_count;
        entry.days_since_last_launch = match (entry.days_since_last_launch, days_since) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (Some(a), None) => Some(a),
            (None, b) => b,
        };
        if let Some(fc) = focus_count {
            entry.focus_count = Some(entry.focus_count.unwrap_or(0) + fc);
        }
        if let Some(ft) = focus_time_ms {
            entry.focus_time_ms = Some(entry.focus_time_ms.unwrap_or(0) + ft);
        }
    }

    aggregated
        .into_iter()
        .map(|((key, is_package), agg)| UserAssistEvidence {
            key,
            is_package,
            launch_count: agg.launch_count,
            days_since_last_launch: agg.days_since_last_launch,
            focus_count: agg.focus_count,
            focus_time_ms: agg.focus_time_ms,
        })
        .collect()
}

// One resolved, already-aggregated default-handler observation, internal to
// the scanner process only. Same key/is_package shape as UserAssistEvidence
// (exact PackageFamilyName match for AppX-backed handlers, fuzzy basename
// match otherwise) — deliberately reusing the identical matching contract
// apply_signals() already applies to every other Guidance Signal.
struct DefaultHandlerEvidence {
    key: String,
    is_package: bool,
    count: u32,
    categories: Vec<String>,
}

// Default-handler ("Environment Integration") evidence — see CLAUDE.md,
// Default-Handler Evidence addendum, for the real-data investigation this
// is based on. Deliberately scoped to PROTOCOL handlers only (http, https,
// mailto): file-extension UserChoice entries (.pdf, .htm, .docx, etc.) were
// checked against this machine's real registry and found consistently
// EMPTY — not present at all, not merely hard to resolve — so that half of
// the original idea is reported as an investigated limitation rather than
// guessed at or shipped on zero real positive examples.
//
// Resolution path, verified against real data: HKCU's per-protocol
// UserChoice key gives a ProgId; `HKCU\Software\Classes\{ProgId}\Application`
// (falling back to HKLM) gives a human-readable ApplicationName and,
// for AppX-backed handlers, an AppUserModelId whose PackageFamilyName
// prefix is the same stable id AppX apps already carry. Windows does not
// expose whether this was a deliberate user choice vs. an installer-set
// default with equal confidence for every entry, so this is intentionally
// treated as modest, corroborating evidence — never a determination — and
// is not wired into scoring anywhere.
fn get_default_handlers() -> Vec<DefaultHandlerEvidence> {
    let ps_script = r#"
$assocs = @(
    @{ Name = 'http'; Category = 'browser' },
    @{ Name = 'https'; Category = 'browser' },
    @{ Name = 'mailto'; Category = 'mail' }
)
$results = foreach ($a in $assocs) {
    $path = "HKCU:\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\$($a.Name)\UserChoice"
    $item = Get-ItemProperty -Path $path -ErrorAction SilentlyContinue
    if (-not $item -or -not $item.ProgId) { continue }
    $progId = $item.ProgId
    $appProps = Get-ItemProperty -Path "HKCU:\Software\Classes\$progId\Application" -ErrorAction SilentlyContinue
    if (-not $appProps) { $appProps = Get-ItemProperty -Path "HKLM:\SOFTWARE\Classes\$progId\Application" -ErrorAction SilentlyContinue }
    if (-not $appProps) { continue }
    $pfn = $null
    # A real AppX AUMID is always "PackageFamilyName!AppId" — a Win32 app can
    # also set its own AppUserModelId (e.g. Chrome sets a plain "Chrome",
    # found via real-data testing), which is NOT a PackageFamilyName and
    # must not be treated as one. Only split on '!' when present.
    if ($appProps.AppUserModelId -and $appProps.AppUserModelId -match '!') {
        $pfn = ($appProps.AppUserModelId -split '!')[0]
    }
    if (-not $appProps.ApplicationName -and -not $pfn) { continue }
    [PSCustomObject]@{
        Category = $a.Category
        AppName = $appProps.ApplicationName
        PackageFamilyName = $pfn
    }
}
$results | ConvertTo-Json
"#;

    let json = match run_powershell_json(ps_script, "default handler scan") {
        Some(v) => v,
        None => return vec![],
    };

    let mut aggregated: HashMap<(String, bool), (u32, Vec<String>)> = HashMap::new();

    for item in json_as_items(&json) {
        let category = match item["Category"].as_str() {
            Some(c) if !c.trim().is_empty() => c.to_string(),
            _ => continue,
        };
        let package_family_name = item["PackageFamilyName"].as_str().filter(|s| !s.trim().is_empty());
        let app_name = item["AppName"].as_str().filter(|s| !s.trim().is_empty());

        let (key, is_package) = match package_family_name {
            Some(pfn) => (pfn.to_string(), true),
            None => match app_name {
                Some(name) => (normalize_name(name), false),
                None => continue,
            },
        };
        if key.is_empty() {
            continue;
        }

        let entry = aggregated.entry((key, is_package)).or_insert((0, Vec::new()));
        entry.0 += 1;
        if !entry.1.contains(&category) {
            entry.1.push(category);
        }
    }

    aggregated
        .into_iter()
        .map(|((key, is_package), (count, categories))| DefaultHandlerEvidence {
            key,
            is_package,
            count,
            categories,
        })
        .collect()
}

// WS4: AppX/MSIX packages, filtered using Get-AppxPackage's own authoritative
// flags — no hardcoded name-pattern list. IsFramework/IsResourcePackage/
// IsBundle removes runtime/language/bundle-wrapper noise; SignatureKind
// removes deep OS-shell plumbing (verified against a real machine: packages
// like CredDialogHost, ShellExperienceHost, PinningConfirmationDialog, and
// dozens like them all carry SignatureKind 'System' and nothing a user would
// call "an app" was found in that group). SignatureKind 'None' is
// deliberately kept, not excluded — that's where PWA-installed web apps
// (Plex, Home Assistant, etc.) showed up on real data, and excluding it
// would have silently dropped genuine user software. What remains still
// mixes genuinely user-installed apps with Windows-bundled inbox ones
// (Calculator, Photos) and a residue of component sub-packages (PowerToys'
// individual context-menu shims, WinAppRuntime version-pinned packages) that
// don't carry any of these flags — accepted as a known, documented
// imprecision rather than over-built into name-pattern guessing.
// `Get-AppxPackage`'s own `Name` is a package identifier ("5319275A.WhatsAppDesktop",
// "7EE7776C.LinkedInforWindows"), not a name a compatibility catalog or a
// human would recognize — many publishers prefix it with an opaque
// hash-like ID with no reliable way to strip programmatically. `Get-StartApps`
// (the same source that powers Start Menu search) already carries the
// genuinely human-readable name Windows itself displays for the app,
// correlatable back to the AppX package via its `AppID`'s PackageFamilyName
// prefix (before the first `!`). Verified against real installs on this
// machine: "5319275A.WhatsAppDesktop" -> "WhatsApp",
// "7EE7776C.LinkedInforWindows" -> "LinkedIn". Falls back to the raw
// package Name when a package has no Start Menu-visible launcher (e.g. a
// background-only component) — same honest "insufficient evidence" fallback
// used elsewhere, not a fabricated name.
fn get_appx_apps() -> Vec<AppEntry> {
    let ps_script = r#"
$startApps = @{}
Get-StartApps | ForEach-Object {
    $pfn = ($_.AppID -split '!')[0]
    if ($pfn -and -not $startApps.ContainsKey($pfn)) { $startApps[$pfn] = $_.Name }
}

Get-AppxPackage | Where-Object {
    -not $_.IsFramework -and -not $_.IsResourcePackage -and -not $_.IsBundle -and $_.SignatureKind -ne 'System'
} | ForEach-Object {
    $friendly = $startApps[$_.PackageFamilyName]
    [PSCustomObject]@{
        Name = if ($friendly) { $friendly } else { $_.Name }
        PackageFamilyName = $_.PackageFamilyName
        Publisher = $_.Publisher
        Version = $_.Version
    }
} | ConvertTo-Json
"#;

    let json = match run_powershell_json(ps_script, "AppX package scan") {
        Some(v) => v,
        None => return vec![],
    };

    let mut apps = Vec::new();

    for item in json_as_items(&json) {
        let name = match item["Name"].as_str() {
            Some(n) if !n.trim().is_empty() => n.to_string(),
            _ => continue,
        };
        // PackageFamilyName is a genuinely stable per-package identifier —
        // used as `id` (like winget's package ID) rather than left None, so
        // Personal Context in the Workspace keys on it instead of falling
        // back to normalized-name matching, which is more collision-prone.
        let package_family_name = item["PackageFamilyName"].as_str().map(|s| s.to_string());
        let version = item["Version"].as_str().map(|s| s.to_string());
        // AppX Publisher is a distinguished name, e.g.
        // "CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, ...".
        // Extract just the CN value for readability.
        let publisher = item["Publisher"].as_str().and_then(|raw| {
            raw.split(',')
                .find(|part| part.trim_start().starts_with("CN="))
                .map(|cn| cn.trim().trim_start_matches("CN=").trim().to_string())
        });

        apps.push(AppEntry {
            name,
            id: package_family_name,
            version,
            recently_used: false, // presence-based signal, not a recency claim
            publisher,
            discovery_source: "appx".to_string(),
            is_running: false,
            is_startup: false,
            has_start_menu_entry: false,
            is_pinned_taskbar: false,
            launch_count: None,
            days_since_last_launch: None,
            focus_count: None,
            focus_time_ms: None,
            default_handler_count: None,
            default_handler_categories: None,
        });
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

    // Cargo.toml's [package] version is the one canonical source — already
    // read the same way into ScanPayload's scanner_version field below, so
    // the console and the submitted payload can never drift apart.
    println!("  Version: v{}", env!("CARGO_PKG_VERSION"));

    // Step 1: System info
    println!("\n[1/4] Collecting system information...");
    let system = get_system_info();
    println!("  OS:   {}", system.os_version);
    println!("  CPU:  {}", system.cpu);
    println!("  RAM:  {} GB", system.ram_gb);
    println!("  Arch: {}", system.architecture);
    println!(
        "  System: {} {}",
        system.system_manufacturer.as_deref().unwrap_or("Unknown"),
        system.system_model.as_deref().unwrap_or("")
    );
    println!(
        "  Battery: {}  |  Discrete GPU: {}  |  Domain-joined: {}",
        system.battery_present, system.discrete_gpu_present, system.domain_joined
    );
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

    // Apps are collected identically regardless of mode — see CLAUDE.md,
    // Assessment levels. The old "Quick mode found no apps, falling back to
    // standard" retry is gone too: that only ever fired because Quick used
    // to filter apps down to nothing on a Prefetch-less machine, which can't
    // happen anymore since nothing filters apps by mode at all now.
    let mut apps = get_installed_apps(&recent, &running);
    println!("  Found {} apps to check", apps.len());

    let arp_apps = get_arp_apps();
    merge_arp_into_apps(&mut apps, arp_apps, &recent, &running);
    println!("  {} total apps after ARP merge", apps.len());

    println!("\nLooking for additional Guidance Signals (running apps, startup apps, Start Menu, AppX)...");
    let known_normalized = normalized_names(&apps);
    let mut appx_apps = filter_unlisted(get_appx_apps(), &known_normalized);
    println!("  Found {} AppX/Store package(s) not already in the inventory", appx_apps.len());

    let mut combined_known = known_normalized;
    combined_known.extend(normalized_names(&appx_apps));
    let mut unlisted_apps = filter_unlisted(get_running_gui_apps(), &combined_known);
    println!("  Found {} running app(s) not already in the inventory", unlisted_apps.len());

    let startup_names = get_startup_names();
    let start_menu_names = get_start_menu_names();
    let pinned_names = get_taskbar_pinned_names();
    let userassist = get_userassist_data();
    println!("  Found UserAssist launch evidence for {} app(s)", userassist.len());
    let default_handlers = get_default_handlers();
    println!("  Found default-handler evidence for {} app(s)", default_handlers.len());
    apply_signals(&mut apps, &running, &startup_names, &start_menu_names, &pinned_names, &userassist, &default_handlers);
    apply_signals(&mut appx_apps, &running, &startup_names, &start_menu_names, &pinned_names, &userassist, &default_handlers);
    apply_signals(&mut unlisted_apps, &running, &startup_names, &start_menu_names, &pinned_names, &userassist, &default_handlers);

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
        payload_version: 1,
        scanner_version: env!("CARGO_PKG_VERSION").to_string(),
        unlisted_apps,
        appx_apps,
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
