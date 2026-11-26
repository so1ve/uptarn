mod collector_dir;
mod exec;
mod monitor;
mod mounts;
mod system;
mod tcp;
mod tls;
mod x509;

use std::future::Future;

use tokio::task::JoinSet;

pub use self::system::{CpuTracker, collect_live_frame};
use crate::config::{AgentConfig, CollectorConfig};
use crate::protocol::{NodeReportPayload, StructuredExecOutput};

async fn collect_parallel<T, O, F, Fut>(items: &[T], f: F) -> Vec<O>
where
    T: Clone + Send + 'static,
    O: Send + 'static,
    F: Fn(T) -> Fut,
    Fut: Future<Output = O> + Send + 'static,
{
    let mut set = JoinSet::new();
    for (idx, item) in items.iter().cloned().enumerate() {
        let fut = f(item);
        set.spawn(async move { (idx, fut.await) });
    }

    let mut out = Vec::with_capacity(items.len());
    while let Some(res) = set.join_next().await {
        out.push(res.expect("collector task panicked"));
    }
    out.sort_by_key(|(idx, _)| *idx);

    out.into_iter().map(|(_, val)| val).collect()
}

async fn run_collector(cfg: CollectorConfig) -> StructuredExecOutput {
    match cfg {
        CollectorConfig::Exec(exec_cfg) => exec::collect_item(&exec_cfg).await,
        CollectorConfig::Tls(tls_cfg) => StructuredExecOutput {
            series: vec![tls::collect_tls_cert(&tls_cfg).await],
            ..StructuredExecOutput::default()
        },
        CollectorConfig::Tcp(tcp_cfg) => StructuredExecOutput {
            series: vec![tcp::collect_tcp_probe(&tcp_cfg).await],
            ..StructuredExecOutput::default()
        },
    }
}

pub async fn collect_report(cfg: &AgentConfig, cpu_tracker: &mut CpuTracker) -> NodeReportPayload {
    let (discovered_collectors, mut checks) = collector_dir::discover(&cfg.collector_dirs);
    let mut all_collectors = Vec::with_capacity(cfg.collectors.len() + discovered_collectors.len());
    all_collectors.extend(cfg.collectors.iter().cloned());
    all_collectors.extend(discovered_collectors);

    let monitor_cfgs = cfg.monitors.as_deref().unwrap_or(&[]);
    let node_interval_secs = cfg.interval_secs;
    let node_grace_secs = cfg.grace_secs;

    let (system, mut mounts, collector_outcomes, collected_monitors) = tokio::join!(
        async {
            if cfg.system.enabled {
                Some(system::collect_system(&cfg.system, cpu_tracker).await)
            } else {
                None
            }
        },
        collect_parallel(
            &cfg.mounts,
            |m| async move { mounts::collect_mount(&m).await }
        ),
        collect_parallel(&all_collectors, run_collector),
        collect_parallel(monitor_cfgs, move |m| async move {
            monitor::collect_monitor(&m, node_interval_secs, node_grace_secs).await
        }),
    );

    if let Some(ref sys) = system {
        checks.extend(system::evaluate_thresholds(&cfg.system, sys));
    }

    let mut series = Vec::new();
    if cfg.system.enabled
        && cfg.system.temperature
        && let Some(temp) = system::collect_temperature()
    {
        series.push(temp);
    }

    let mut info = Vec::new();
    if cfg.system.enabled && cfg.system.os_info {
        info.extend(system::collect_os_info());
    }
    info.extend(cfg.info.iter().cloned());

    let mut jobs = Vec::new();
    for out in collector_outcomes {
        mounts.extend(out.mounts);
        checks.extend(out.checks);
        series.extend(out.series);
        info.extend(out.info);
        jobs.extend(out.jobs);
    }

    NodeReportPayload {
        node_id: cfg.node_id.clone(),
        label: cfg.label.clone(),
        agent_version: Some(env!("CARGO_PKG_VERSION").to_string()),
        interval_secs: Some(cfg.interval_secs),
        grace_secs: cfg.grace_secs,
        is_public: cfg.is_public,
        system,
        mounts,
        checks,
        series,
        info,
        monitors: cfg.monitors.is_some().then_some(collected_monitors),
        jobs,
    }
}
