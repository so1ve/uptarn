use std::fs;
use std::path::Path;
use std::time::Duration;

use crate::config::SystemCollectConfig;
use crate::protocol::{HealthStatus, InfoSnapshot, SeriesSnapshot, SeriesUnit, SystemSnapshot};

const VIRTUAL_IFACE_PREFIXES: &[&str] = &[
    "veth",
    "docker",
    "podman",
    "br-",
    "cni",
    "virbr",
    "tailscale",
    "wg",
    "tun",
    "tap",
    "utun",
    "zt",
    "nebula",
    "flannel",
    "cali",
];

const CPU_THERMAL_KEYWORDS: &[&str] = &["x86_pkg_temp", "coretemp", "k10temp", "cpu", "soc"];

#[derive(Debug, Default)]
pub struct CpuTracker {
    prev: Option<(u64, u64)>,
}

impl CpuTracker {
    pub async fn sample_pct(&mut self) -> Option<f64> {
        let current = read_cpu_jiffies()?;
        if let Some((prev_idle, prev_total)) = self.prev {
            self.prev = Some(current);

            return compute_cpu_pct(prev_idle, prev_total, current.0, current.1);
        }

        tokio::time::sleep(Duration::from_millis(120)).await;
        let next = read_cpu_jiffies()?;
        self.prev = Some(next);

        compute_cpu_pct(current.0, current.1, next.0, next.1)
    }
}

fn compute_cpu_pct(prev_idle: u64, prev_total: u64, idle: u64, total: u64) -> Option<f64> {
    let total_delta = total.checked_sub(prev_total)?;
    let idle_delta = idle.checked_sub(prev_idle)?;
    if total_delta == 0 {
        return Some(0.0);
    }
    let pct = (total_delta.saturating_sub(idle_delta) as f64 / total_delta as f64) * 100.0;

    Some((pct * 10.0).round() / 10.0)
}

fn read_cpu_jiffies() -> Option<(u64, u64)> {
    let stat = fs::read_to_string("/proc/stat").ok()?;
    let line = stat.lines().find(|l| l.starts_with("cpu "))?;
    let vals: Vec<u64> = line
        .split_whitespace()
        .skip(1)
        .filter_map(|p| p.parse().ok())
        .collect();
    if vals.len() < 4 {
        return None;
    }
    let idle = vals[3] + vals.get(4).copied().unwrap_or(0);

    Some((idle, vals.iter().sum()))
}

fn read_first_f64(path: &str) -> Option<f64> {
    fs::read_to_string(path)
        .ok()?
        .split_whitespace()
        .next()?
        .parse()
        .ok()
}

#[derive(Debug, Default, PartialEq, Eq)]
struct MemInfo {
    mem_used_bytes: Option<u64>,
    mem_total_bytes: Option<u64>,
    swap_used_bytes: Option<u64>,
    swap_total_bytes: Option<u64>,
}

const fn used_and_total(
    total_kib: Option<u64>,
    free_kib: Option<u64>,
    nonzero_only: bool,
) -> (Option<u64>, Option<u64>) {
    match (total_kib, free_kib) {
        (Some(total), Some(free)) if !nonzero_only || total > 0 => {
            let total_b = total * 1024;
            (Some(total_b.saturating_sub(free * 1024)), Some(total_b))
        }
        _ => (None, None),
    }
}

fn parse_meminfo(raw: &str) -> MemInfo {
    let (mut mem_total, mut mem_avail, mut swap_total, mut swap_free) = (None, None, None, None);
    for line in raw.lines() {
        let Some((key, rest)) = line.split_once(':') else {
            continue;
        };
        let val = rest.split_whitespace().next().and_then(|v| v.parse().ok());
        match key {
            "MemTotal" => mem_total = val,
            "MemAvailable" => mem_avail = val,
            "SwapTotal" => swap_total = val,
            "SwapFree" => swap_free = val,
            _ => {}
        }
    }

    let (mem_used_bytes, mem_total_bytes) = used_and_total(mem_total, mem_avail, false);
    let (swap_used_bytes, swap_total_bytes) = used_and_total(swap_total, swap_free, true);

    MemInfo {
        mem_used_bytes,
        mem_total_bytes,
        swap_used_bytes,
        swap_total_bytes,
    }
}

fn is_virtual_interface_name(name: &str) -> bool {
    name == "lo"
        || VIRTUAL_IFACE_PREFIXES
            .iter()
            .any(|prefix| name.starts_with(prefix))
}

fn is_physical_interface(name: &str) -> bool {
    if is_virtual_interface_name(name) {
        return false;
    }
    let sysfs = Path::new("/sys/class/net").join(name);

    !sysfs.exists() || sysfs.join("device").exists()
}

fn read_network_bytes(allowlist: &[String]) -> Option<(u64, u64)> {
    let raw = fs::read_to_string("/proc/net/dev").ok()?;
    let (mut rx_total, mut tx_total) = (0u64, 0u64);
    for line in raw.lines().skip(2) {
        let Some((iface_raw, stats_raw)) = line.split_once(':') else {
            continue;
        };
        let iface = iface_raw.trim();
        let include = if allowlist.is_empty() {
            is_physical_interface(iface)
        } else {
            allowlist.iter().any(|allowed| allowed == iface)
        };
        if !include {
            continue;
        }
        let mut cols = stats_raw.split_whitespace();
        if let (Some(rx_s), Some(tx_s)) = (cols.next(), cols.nth(7))
            && let (Ok(rx), Ok(tx)) = (rx_s.parse::<u64>(), tx_s.parse::<u64>())
        {
            rx_total = rx_total.saturating_add(rx);
            tx_total = tx_total.saturating_add(tx);
        }
    }

    Some((rx_total, tx_total))
}

fn parse_os_pretty_name(raw: &str) -> Option<String> {
    raw.lines()
        .find_map(|line| line.strip_prefix("PRETTY_NAME="))
        .map(|rest| rest.trim().trim_matches(['"', '\'']).trim())
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

pub fn collect_temperature() -> Option<SeriesSnapshot> {
    let entries = fs::read_dir("/sys/class/thermal").ok()?;
    let (mut preferred, mut fallback) = (None::<f64>, None::<f64>);

    for entry in entries.filter_map(Result::ok) {
        if !entry
            .file_name()
            .to_string_lossy()
            .starts_with("thermal_zone")
        {
            continue;
        }
        let path = entry.path();
        let Ok(millideg) = fs::read_to_string(path.join("temp"))
            .ok()
            .as_deref()
            .unwrap_or("")
            .trim()
            .parse::<i64>()
        else {
            continue;
        };
        let celsius = millideg as f64 / 1000.0;
        if !(0.0..=130.0).contains(&celsius) {
            continue;
        }

        let zone_type = fs::read_to_string(path.join("type"))
            .unwrap_or_default()
            .trim()
            .to_ascii_lowercase();
        let slot = if CPU_THERMAL_KEYWORDS.iter().any(|kw| zone_type.contains(kw)) {
            &mut preferred
        } else {
            &mut fallback
        };
        *slot = Some(slot.map(|cur| cur.max(celsius)).unwrap_or(celsius));
    }

    let value = (preferred.or(fallback)? * 10.0).round() / 10.0;
    let status = if value >= 95.0 {
        HealthStatus::Fail
    } else if value >= 80.0 {
        HealthStatus::Warn
    } else {
        HealthStatus::Ok
    };

    Some(SeriesSnapshot {
        key: "cpu_temp".to_string(),
        label: "Temperature".to_string(),
        group: Some("system".to_string()),
        unit: SeriesUnit::Celsius,
        value,
        loss_pct: None,
        status: Some(status),
        summary: Some(format!("{value:.1}°C")),
    })
}

pub async fn collect_system(
    cfg: &SystemCollectConfig,
    cpu_tracker: &mut CpuTracker,
) -> Option<SystemSnapshot> {
    if !cfg.enabled {
        return None;
    }

    let cpu_pct = if cfg.cpu {
        cpu_tracker.sample_pct().await
    } else {
        None
    };
    let mem = if cfg.memory {
        fs::read_to_string("/proc/meminfo")
            .map(|raw| parse_meminfo(&raw))
            .unwrap_or_default()
    } else {
        MemInfo::default()
    };
    let (rx_bytes, tx_bytes) = cfg
        .network
        .then(|| read_network_bytes(&cfg.interfaces))
        .flatten()
        .unzip();

    Some(SystemSnapshot {
        uptime_secs: read_first_f64("/proc/uptime").unwrap_or(0.0) as u64,
        cpu_pct,
        load_1m: cfg.load.then(|| read_first_f64("/proc/loadavg")).flatten(),
        mem_used_bytes: mem.mem_used_bytes,
        mem_total_bytes: mem.mem_total_bytes,
        swap_used_bytes: mem.swap_used_bytes,
        swap_total_bytes: mem.swap_total_bytes,
        rx_bytes,
        tx_bytes,
    })
}

pub fn collect_os_info() -> Vec<InfoSnapshot> {
    let mut info = Vec::new();
    let mut push = |key: &str, label: &str, value: String| {
        info.push(InfoSnapshot {
            key: key.to_string(),
            label: label.to_string(),
            group: Some("system".to_string()),
            value,
        });
    };

    if let Ok(raw) = fs::read_to_string("/etc/os-release")
        && let Some(os) = parse_os_pretty_name(&raw)
    {
        push("os", "OS", os);
    }
    let uname = rustix::system::uname();
    let release = uname.release().to_string_lossy();
    if !release.is_empty() {
        push("kernel", "Kernel", release.into_owned());
    }
    push("arch", "Arch", std::env::consts::ARCH.to_string());
    if let Ok(cores) = std::thread::available_parallelism() {
        let n = cores.get();
        push(
            "cpu_cores",
            "CPU",
            if n == 1 {
                "1 core".to_string()
            } else {
                format!("{n} cores")
            },
        );
    }

    info
}

#[cfg(test)]
mod tests {
    use super::{is_virtual_interface_name, parse_meminfo, parse_os_pretty_name};

    #[test]
    fn parses_memory_and_swap_from_meminfo() {
        let raw = "MemTotal:       4000000 kB
MemFree:         500000 kB
MemAvailable:   1500000 kB
SwapTotal:      2000000 kB
SwapFree:       1750000 kB
";
        let info = parse_meminfo(raw);
        assert_eq!(info.mem_total_bytes, Some(4_000_000 * 1024));
        assert_eq!(info.mem_used_bytes, Some(2_500_000 * 1024));
        assert_eq!(info.swap_total_bytes, Some(2_000_000 * 1024));
        assert_eq!(info.swap_used_bytes, Some(250_000 * 1024));
    }

    #[test]
    fn omits_swap_when_swap_total_is_zero() {
        let raw = "MemTotal: 1000 kB
MemAvailable: 400 kB
SwapTotal: 0 kB
SwapFree: 0 kB
";
        let info = parse_meminfo(raw);
        assert_eq!(info.swap_total_bytes, None);
        assert_eq!(info.swap_used_bytes, None);
    }

    #[test]
    fn filters_tunnel_and_container_interfaces() {
        assert!(is_virtual_interface_name("lo"));
        assert!(is_virtual_interface_name("tailscale0"));
        assert!(is_virtual_interface_name("wg0"));
        assert!(is_virtual_interface_name("br-traefik"));
        assert!(is_virtual_interface_name("veth12"));
        assert!(!is_virtual_interface_name("ens18"));
        assert!(!is_virtual_interface_name("eth0"));
    }

    #[test]
    fn extracts_os_pretty_name() {
        let raw = "NAME=NixOS\nPRETTY_NAME=\"NixOS 26.11 (Zokor)\"\n";
        assert_eq!(
            parse_os_pretty_name(raw).as_deref(),
            Some("NixOS 26.11 (Zokor)")
        );
    }
}
