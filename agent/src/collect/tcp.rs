use std::time::{Duration, Instant};

use tokio::net::TcpStream;
use tokio::time::timeout;

use crate::config::TcpProbeConfig;
use crate::protocol::{HealthStatus, SeriesSnapshot, SeriesUnit};

pub async fn collect_tcp_probe(cfg: &TcpProbeConfig) -> SeriesSnapshot {
    let attempts = cfg.count.max(1);
    let mut rtts = Vec::with_capacity(attempts as usize);
    let mut losses = 0u32;

    for idx in 0..attempts {
        if idx > 0 {
            tokio::time::sleep(Duration::from_millis(80)).await;
        }
        let started = Instant::now();
        if let Ok(Ok(_stream)) = timeout(
            Duration::from_millis(cfg.timeout_ms),
            TcpStream::connect(&cfg.target),
        )
        .await
        {
            rtts.push(started.elapsed().as_secs_f64() * 1000.0);
        } else {
            losses += 1;
        }
    }

    let loss_pct = (f64::from(losses) / f64::from(attempts)) * 100.0;
    let avg_ms = if rtts.is_empty() {
        cfg.timeout_ms as f64
    } else {
        let sum: f64 = rtts.iter().sum();
        ((sum / rtts.len() as f64) * 10.0).round() / 10.0
    };

    let status = if rtts.is_empty() || loss_pct >= cfg.fail_loss_pct || avg_ms >= cfg.fail_ms {
        HealthStatus::Fail
    } else if loss_pct >= cfg.warn_loss_pct || avg_ms >= cfg.warn_ms {
        HealthStatus::Warn
    } else {
        HealthStatus::Ok
    };

    let summary = if rtts.is_empty() {
        "100% loss (unreachable)".to_string()
    } else {
        format!("{avg_ms:.1} ms, {loss_pct:.0}% loss")
    };

    SeriesSnapshot {
        key: cfg.key.clone(),
        label: cfg.label.clone(),
        group: cfg.group.clone(),
        unit: SeriesUnit::Ms,
        value: avg_ms,
        loss_pct: Some(loss_pct),
        status: Some(status),
        summary: Some(summary),
    }
}
