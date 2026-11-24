mod exec;
mod mounts;
mod system;
mod tcp;
mod tls;
mod x509;

use std::future::Future;

use tokio::task::JoinSet;

pub use self::system::CpuTracker;
use crate::config::AgentConfig;
use crate::protocol::NodeReportPayload;

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

pub async fn collect_report(cfg: &AgentConfig, cpu_tracker: &mut CpuTracker) -> NodeReportPayload {
    let (discovered_exec, mut checks) = exec::discover_exec_dirs(&cfg.exec_dirs);
    let mut all_exec = Vec::with_capacity(cfg.exec.len() + discovered_exec.len());
    all_exec.extend(cfg.exec.iter().cloned());
    all_exec.extend(discovered_exec);

    let (system, mut mounts, tcp_series, tls_series, exec_outcomes) = tokio::join!(
        system::collect_system(&cfg.system, cpu_tracker),
        collect_parallel(
            &cfg.mounts,
            |m| async move { mounts::collect_mount(&m).await }
        ),
        collect_parallel(&cfg.tcp_probes, |p| async move {
            tcp::collect_tcp_probe(&p).await
        }),
        collect_parallel(&cfg.tls_certs, |c| async move {
            tls::collect_tls_cert(&c).await
        }),
        collect_parallel(
            &all_exec,
            |e| async move { exec::collect_exec_item(&e).await }
        ),
    );

    let mut series = Vec::with_capacity(tcp_series.len() + tls_series.len());
    series.extend(tcp_series);
    series.extend(tls_series);

    let mut info = Vec::new();
    if cfg.system.enabled && cfg.system.os_info {
        info.extend(system::collect_os_info());
    }
    info.extend(cfg.info.iter().cloned());

    for out in exec_outcomes {
        mounts.extend(out.mounts);
        checks.extend(out.checks);
        series.extend(out.series);
        info.extend(out.info);
    }

    NodeReportPayload {
        node_id: cfg.node_id.clone(),
        label: cfg.label.clone(),
        agent_version: Some(env!("CARGO_PKG_VERSION").to_string()),
        interval_secs: Some(cfg.interval_secs),
        grace_secs: cfg.grace_secs,
        system,
        mounts,
        checks,
        series,
        info,
    }
}
