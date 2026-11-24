use std::fs;
use std::time::Duration;

use crate::config::SystemCollectConfig;
use crate::protocol::{InfoSnapshot, SystemSnapshot};

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

fn read_memory_bytes() -> Option<(u64, u64)> {
    let raw = fs::read_to_string("/proc/meminfo").ok()?;
    let mut mem_total_kib: Option<u64> = None;
    let mut mem_avail_kib: Option<u64> = None;
    for line in raw.lines() {
        if let Some(rest) = line.strip_prefix("MemTotal:") {
            mem_total_kib = rest.split_whitespace().next().and_then(|v| v.parse().ok());
        } else if let Some(rest) = line.strip_prefix("MemAvailable:") {
            mem_avail_kib = rest.split_whitespace().next().and_then(|v| v.parse().ok());
        }
    }
    let total = mem_total_kib? * 1024;
    let avail = mem_avail_kib? * 1024;

    Some((total.saturating_sub(avail), total))
}

fn is_virtual_interface(name: &str) -> bool {
    name == "lo"
        || name.starts_with("veth")
        || name.starts_with("docker")
        || name.starts_with("podman")
        || name.starts_with("br-")
        || name.starts_with("cni")
        || name.starts_with("virbr")
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
            !is_virtual_interface(iface)
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
    let (mem_used_bytes, mem_total_bytes) = cfg.memory.then(read_memory_bytes).flatten().unzip();
    let (rx_bytes, tx_bytes) = cfg
        .network
        .then(|| read_network_bytes(&cfg.interfaces))
        .flatten()
        .unzip();

    Some(SystemSnapshot {
        uptime_secs: read_uptime_secs().unwrap_or(0),
        cpu_pct,
        load_1m: cfg.load.then(read_load_1m).flatten(),
        mem_used_bytes,
        mem_total_bytes,
        rx_bytes,
        tx_bytes,
    })
}

pub fn collect_os_info() -> Vec<InfoSnapshot> {
    let mut info = Vec::new();
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

    info
}
