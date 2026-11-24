use std::time::Duration;

use anyhow::Result;
use tokio::time::timeout;

use crate::config::MountConfig;
use crate::protocol::{HealthStatus, MountSnapshot};

pub async fn collect_mount(cfg: &MountConfig) -> MountSnapshot {
    let path_str = cfg.path.clone();
    let fut = tokio::task::spawn_blocking(move || statvfs_bytes(&path_str));
    let Ok(joined) = timeout(Duration::from_millis(cfg.timeout_ms), fut).await else {
        return MountSnapshot::failed(
            cfg.path.clone(),
            cfg.label.clone(),
            "mount check timed out (stale mount?)",
        );
    };
    let (used, total) = match joined.expect("statvfs worker panicked") {
        Ok(bytes) => bytes,
        Err(err) => {
            return MountSnapshot::failed(
                cfg.path.clone(),
                cfg.label.clone(),
                format!("statvfs error: {err}"),
            );
        }
    };

    let pct = if total > 0 {
        (used as f64 / total as f64) * 100.0
    } else {
        0.0
    };
    let status = if pct >= cfg.fail_pct {
        HealthStatus::Fail
    } else if pct >= cfg.warn_pct {
        HealthStatus::Warn
    } else {
        HealthStatus::Ok
    };

    MountSnapshot {
        path: cfg.path.clone(),
        label: cfg.label.clone(),
        used_bytes: used,
        total_bytes: total,
        status,
        summary: Some(format!("{pct:.1}% used")),
    }
}

fn statvfs_bytes(path: &str) -> Result<(u64, u64)> {
    let stat = rustix::fs::statvfs(path)?;
    let frsize = if stat.f_frsize > 0 {
        stat.f_frsize
    } else {
        stat.f_bsize
    };
    let total = stat.f_blocks.saturating_mul(frsize);
    let avail = stat.f_bavail.saturating_mul(frsize);
    let free_all = stat.f_bfree.saturating_mul(frsize);
    let used = total.saturating_sub(free_all);
    let effective_total = used.saturating_add(avail);

    Ok((
        used,
        if effective_total > 0 {
            effective_total
        } else {
            total
        },
    ))
}
