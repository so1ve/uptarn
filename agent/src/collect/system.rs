use std::fs;
use std::path::Path;
use std::time::Duration;

use crate::config::SystemCollectConfig;
use crate::protocol::{HealthStatus, InfoSnapshot, SeriesSnapshot, SeriesUnit, SystemSnapshot};

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
    let busy = total_delta.saturating_sub(idle_delta);
    let pct = (busy as f64 / total_delta as f64) * 100.0;

    Some((pct * 10.0).round() / 10.0)
}

fn read_cpu_jiffies() -> Option<(u64, u64)> {
    let stat = fs::read_to_string("/proc/stat").ok()?;
    let line = stat.lines().find(|l| l.starts_with("cpu "))?;
    let mut idle = 0u64;
    let mut total = 0u64;
    let mut count = 0usize;
    for part in line.split_whitespace().skip(1) {
        let Ok(v) = part.parse::<u64>() else {
            continue;
        };
        if count == 3 || count == 4 {
            idle += v;
        }
        total += v;
        count += 1;
    }
    if count < 4 {
        return None;
    }

    Some((idle, total))
}

fn read_uptime_secs() -> Option<u64> {
    let raw = fs::read_to_string("/proc/uptime").ok()?;
    let secs: f64 = raw.split_whitespace().next()?.parse().ok()?;

    Some(secs as u64)
}

fn read_load_1m() -> Option<f64> {
    let raw = fs::read_to_string("/proc/loadavg").ok()?;

    raw.split_whitespace().next()?.parse().ok()
}

#[derive(Debug, Default, PartialEq, Eq)]
struct MemInfo {
    mem_used_bytes: Option<u64>,
    mem_total_bytes: Option<u64>,
    swap_used_bytes: Option<u64>,
    swap_total_bytes: Option<u64>,
}

fn parse_meminfo(raw: &str) -> MemInfo {
    let mut mem_total_kib: Option<u64> = None;
    let mut mem_avail_kib: Option<u64> = None;
    let mut swap_total_kib: Option<u64> = None;
    let mut swap_free_kib: Option<u64> = None;

    for line in raw.lines() {
        let parse_field = |prefix: &str, slot: &mut Option<u64>| {
            if let Some(rest) = line.strip_prefix(prefix) {
                *slot = rest.split_whitespace().next().and_then(|v| v.parse().ok());
            }
        };
        parse_field("MemTotal:", &mut mem_total_kib);
        parse_field("MemAvailable:", &mut mem_avail_kib);
        parse_field("SwapTotal:", &mut swap_total_kib);
        parse_field("SwapFree:", &mut swap_free_kib);
    }

    let (mem_used_bytes, mem_total_bytes) = match (mem_total_kib, mem_avail_kib) {
        (Some(total), Some(avail)) => {
            let total_b = total * 1024;
            let avail_b = avail * 1024;
            (Some(total_b.saturating_sub(avail_b)), Some(total_b))
        }
        _ => (None, None),
    };

    let (swap_used_bytes, swap_total_bytes) = match (swap_total_kib, swap_free_kib) {
        (Some(total), Some(free)) if total > 0 => {
            let total_b = total * 1024;
            let free_b = free * 1024;
            (Some(total_b.saturating_sub(free_b)), Some(total_b))
        }
        _ => (None, None),
    };

    MemInfo {
        mem_used_bytes,
        mem_total_bytes,
        swap_used_bytes,
        swap_total_bytes,
    }
}

fn read_memory_info() -> MemInfo {
    fs::read_to_string("/proc/meminfo")
        .map(|raw| parse_meminfo(&raw))
        .unwrap_or_default()
}

fn is_virtual_interface_name(name: &str) -> bool {
    name == "lo"
        || name.starts_with("veth")
        || name.starts_with("docker")
        || name.starts_with("podman")
        || name.starts_with("br-")
        || name.starts_with("cni")
        || name.starts_with("virbr")
        || name.starts_with("tailscale")
        || name.starts_with("wg")
        || name.starts_with("tun")
        || name.starts_with("tap")
        || name.starts_with("utun")
        || name.starts_with("zt")
        || name.starts_with("nebula")
        || name.starts_with("flannel")
        || name.starts_with("cali")
}

fn is_physical_interface(name: &str) -> bool {
    if is_virtual_interface_name(name) {
        return false;
    }
    let sysfs = Path::new("/sys/class/net").join(name);
    if sysfs.exists() {
        return sysfs.join("device").exists();
    }

    true
}

fn read_network_bytes(allowlist: &[String]) -> Option<(u64, u64)> {
    let raw = fs::read_to_string("/proc/net/dev").ok()?;
    let mut rx_total = 0u64;
    let mut tx_total = 0u64;
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
    for line in raw.lines() {
        if let Some(rest) = line.strip_prefix("PRETTY_NAME=") {
            let trimmed = rest.trim().trim_matches(['"', '\'']).trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }

    None
}

pub fn collect_temperature() -> Option<SeriesSnapshot> {
    let entries = fs::read_dir("/sys/class/thermal").ok()?;
    let mut preferred: Option<f64> = None;
    let mut fallback: Option<f64> = None;

    for entry in entries.filter_map(Result::ok) {
        let name = entry.file_name();
        if !name.to_string_lossy().starts_with("thermal_zone") {
            continue;
        }
        let path = entry.path();
        let Ok(raw_temp) = fs::read_to_string(path.join("temp")) else {
            continue;
        };
        let Ok(millideg) = raw_temp.trim().parse::<i64>() else {
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
        let is_cpu_zone = zone_type.contains("x86_pkg_temp")
            || zone_type.contains("coretemp")
            || zone_type.contains("k10temp")
            || zone_type.contains("cpu")
            || zone_type.contains("soc");

        if is_cpu_zone {
            preferred = Some(preferred.map(|cur| cur.max(celsius)).unwrap_or(celsius));
        } else {
            fallback = Some(fallback.map(|cur| cur.max(celsius)).unwrap_or(celsius));
        }
    }

    let raw_c = preferred.or(fallback)?;
    let value = (raw_c * 10.0).round() / 10.0;
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
        read_memory_info()
    } else {
        MemInfo::default()
    };
    let (rx_bytes, tx_bytes) = cfg
        .network
        .then(|| read_network_bytes(&cfg.interfaces))
        .flatten()
        .unzip();

    Some(SystemSnapshot {
        uptime_secs: read_uptime_secs().unwrap_or(0),
        cpu_pct,
        load_1m: cfg.load.then(read_load_1m).flatten(),
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
    if let Ok(raw) = fs::read_to_string("/etc/os-release")
        && let Some(os) = parse_os_pretty_name(&raw)
    {
        info.push(InfoSnapshot {
            key: "os".to_string(),
            label: "OS".to_string(),
            group: Some("system".to_string()),
            value: os,
        });
    }
    let uname = rustix::system::uname();
    let release = uname.release().to_string_lossy();
    if !release.is_empty() {
        info.push(InfoSnapshot {
            key: "kernel".to_string(),
            label: "Kernel".to_string(),
            group: Some("system".to_string()),
            value: release.into_owned(),
        });
    }
    info.push(InfoSnapshot {
        key: "arch".to_string(),
        label: "Arch".to_string(),
        group: Some("system".to_string()),
        value: std::env::consts::ARCH.to_string(),
    });
    if let Ok(cores) = std::thread::available_parallelism() {
        let count = cores.get();
        info.push(InfoSnapshot {
            key: "cpu_cores".to_string(),
            label: "CPU".to_string(),
            group: Some("system".to_string()),
            value: if count == 1 {
                "1 core".to_string()
            } else {
                format!("{count} cores")
            },
        });
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
