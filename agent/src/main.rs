mod collect;
mod config;
mod hub;
mod job;
mod live;
mod protocol;

use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::Result;
use clap::{CommandFactory, Parser, Subcommand};
use clap_complete::Shell;

use crate::collect::{CpuTracker, collect_report};
use crate::config::AgentConfig;
use crate::hub::HubClient;
use crate::job::run_job_wrapper;

#[derive(Debug, Parser)]
#[command(
    name = "uptarn-agent",
    version,
    about = "Static Linux agent and cron job wrapper for Uptarn"
)]
struct Cli {
    /// Path to agent TOML config
    #[arg(
        short,
        long,
        env = "UPTARN_CONFIG",
        default_value = "/etc/uptarn/agent.toml",
        global = true
    )]
    config: PathBuf,
    #[command(subcommand)]
    command: Commands,
}

#[derive(Debug, Subcommand)]
enum Commands {
    /// Run periodic telemetry collection and report loop
    Daemon,
    /// Collect one snapshot and print JSON (pass --push to also submit to hub)
    Once {
        /// Also submit the collected snapshot to the hub
        #[arg(long)]
        push: bool,
    },
    /// Execute a command and report job completion or failure to Uptarn
    Run {
        /// Unique job key (e.g. homelab-restic)
        #[arg(long)]
        job: String,
        /// Optional display label
        #[arg(long)]
        label: Option<String>,
        /// Expected schedule interval (e.g. 24h, 30m, 3600s)
        #[arg(long)]
        every: String,
        /// Grace window before job is marked overdue (e.g. 2h, 30m)
        #[arg(long, default_value = "1h")]
        grace: String,
        /// Command and arguments to execute
        #[arg(required = true, trailing_var_arg = true)]
        cmd: Vec<String>,
    },
    /// Generate shell completions
    Completions {
        /// Target shell
        shell: Shell,
    },
}

async fn run_daemon(config_path: &Path) -> Result<()> {
    let cfg = AgentConfig::load(config_path)?;
    let token = cfg.resolved_token()?;
    let client = HubClient::from_config(&cfg)?;
    let mut cpu_tracker = CpuTracker::default();
    let mut ticker = tokio::time::interval(Duration::from_secs(cfg.interval_secs.max(10)));
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    // Push the first full report before opening the live stream so
    // auto-registration succeeds first.
    ticker.tick().await;
    let first_report = collect_report(&cfg, &mut cpu_tracker).await;
    if let Err(err) = client.post_report(&first_report).await {
        eprintln!("uptarn-agent: report push failed: {err:#}");
    }

    let live_fut = live::run_live_loop(cfg.clone(), token);
    tokio::pin!(live_fut);

    loop {
        tokio::select! {
            _ = ticker.tick() => {
                let report = collect_report(&cfg, &mut cpu_tracker).await;
                if let Err(err) = client.post_report(&report).await {
                    eprintln!("uptarn-agent: report push failed: {err:#}");
                }
            }
            () = &mut live_fut => {}
            _ = tokio::signal::ctrl_c() => break,
        }
    }

    Ok(())
}

async fn run_once(config_path: &Path, push: bool) -> Result<()> {
    let cfg = AgentConfig::load(config_path)?;
    let mut cpu_tracker = CpuTracker::default();
    let report = collect_report(&cfg, &mut cpu_tracker).await;
    println!("{}", serde_json::to_string_pretty(&report)?);

    if push {
        HubClient::from_config(&cfg)?.post_report(&report).await?;
    }

    Ok(())
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<()> {
    rustls::crypto::ring::default_provider()
        .install_default()
        .expect("install rustls ring crypto provider");

    let cli = Cli::parse();
    match cli.command {
        Commands::Daemon => run_daemon(&cli.config).await,
        Commands::Once { push } => run_once(&cli.config, push).await,
        Commands::Run {
            job,
            label,
            every,
            grace,
            cmd,
        } => {
            let code = run_job_wrapper(&cli.config, job, label, &every, &grace, &cmd).await?;
            if code != 0 {
                std::process::exit(code);
            }

            Ok(())
        }
        Commands::Completions { shell } => {
            let mut cmd = Cli::command();
            clap_complete::generate(shell, &mut cmd, "uptarn-agent", &mut io::stdout());

            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use tempfile::NamedTempFile;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    use super::*;
    use crate::config::parse_duration_secs;
    use crate::protocol::{HealthStatus, MonitorProbeType, MonitorSpec};

    fn write_test_file(path: impl AsRef<Path>, body: &str, executable: bool) {
        use std::os::unix::fs::PermissionsExt;

        std::fs::write(path.as_ref(), body).unwrap();
        let mode = if executable { 0o755 } else { 0o644 };
        std::fs::set_permissions(path.as_ref(), std::fs::Permissions::from_mode(mode)).unwrap();
    }

    #[test]
    fn parses_human_durations() {
        assert_eq!(parse_duration_secs("60").unwrap(), 60);
        assert_eq!(parse_duration_secs("90s").unwrap(), 90);
        assert_eq!(parse_duration_secs("15m").unwrap(), 900);
        assert_eq!(parse_duration_secs("24h").unwrap(), 86_400);
        assert_eq!(parse_duration_secs("2d").unwrap(), 172_800);
    }

    #[tokio::test]
    async fn collects_minimal_dsm_and_structured_check_snapshot() {
        let mut token_file = NamedTempFile::new().unwrap();
        writeln!(token_file, "uptn_node_secret").unwrap();

        let mut cfg_file = NamedTempFile::new().unwrap();
        write!(
            cfg_file,
            r#"
hub_url = "https://status.example.com/"
node_id = "router"
label = "OpenWrt"
token_file = "{token_path}"
interval_secs = 60

[system]
cpu = false
memory = false
load = false
network = false
os_info = false

[[mounts]]
path = "/tmp"
label = "Temp"

[[checks]]
key = "router_ext"
label = "Router checks"
format = "json"
command = ["sh", "-c", 'printf "%s" "{{\"checks\":[{{\"key\":\"tailscale\",\"label\":\"Tailscale\",\"group\":\"net\",\"status\":\"ok\",\"summary\":\"online\"}}],\"info\":[{{\"key\":\"wan6\",\"label\":\"WAN IPv6\",\"value\":\"2001:db8::1\"}}]}}"']
"#,
            token_path = token_file.path().display()
        )
        .unwrap();

        let cfg = AgentConfig::load(cfg_file.path()).unwrap();
        assert_eq!(cfg.hub_url, "https://status.example.com");
        assert_eq!(cfg.resolved_token().unwrap(), "uptn_node_secret");

        let mut cpu = CpuTracker::default();
        let report = collect_report(&cfg, &mut cpu).await;
        assert_eq!(report.node_id, "router");
        assert!(report.grace_secs.is_none());
        assert!(report.system.as_ref().unwrap().cpu_pct.is_none());
        assert_eq!(report.mounts.len(), 1);
        assert_eq!(report.checks.len(), 1);
        assert_eq!(report.checks[0].key, "tailscale");
        assert_eq!(report.info.len(), 1);
        assert_eq!(report.info[0].value, "2001:db8::1");
    }

    #[tokio::test]
    async fn discovers_check_dirs_and_dynamic_mounts_without_reload() {
        let dir = tempfile::tempdir().unwrap();
        let write_script = |name: &str, body: &str, executable: bool| {
            write_test_file(dir.path().join(name), body, executable);
        };

        write_script(
            "10-usb.sh",
            "#!/bin/sh\nprintf '%s' '{\"mounts\":[{\"path\":\"/mnt/usb\",\"label\":\"USB\",\"used_bytes\":100,\"total_bytes\":1000,\"status\":\"ok\"}],\"info\":[{\"key\":\"usb_dev\",\"label\":\"USB\",\"value\":\"sda1\"}]}'\n",
            true,
        );
        write_script("20-plain.sh", "#!/bin/sh\necho all good\n", true);
        write_script("ignored.txt", "#!/bin/sh\necho nope\n", false);
        write_script(".hidden.sh", "#!/bin/sh\necho hidden\n", true);

        let mut cfg_file = NamedTempFile::new().unwrap();
        write!(
            cfg_file,
            r#"
hub_url = "https://status.example.com"
node_id = "nas"
token = "uptn_tok"
check_dirs = ["{dir_path}"]

[system]
enabled = false
"#,
            dir_path = dir.path().display()
        )
        .unwrap();

        let cfg = AgentConfig::load(cfg_file.path()).unwrap();
        let mut cpu = CpuTracker::default();
        let first = collect_report(&cfg, &mut cpu).await;
        assert_eq!(first.mounts.len(), 1);
        assert_eq!(first.mounts[0].path, "/mnt/usb");
        assert_eq!(first.info.len(), 1);
        assert_eq!(first.info[0].key, "usb_dev");
        assert_eq!(first.checks.len(), 1);
        assert_eq!(first.checks[0].key, "20-plain");
        assert_eq!(first.checks[0].summary.as_deref(), Some("all good"));

        write_script(
            "30-extra.sh",
            "#!/bin/sh\necho progress step\necho fatal: disk offline >&2\nexit 1\n",
            true,
        );
        let second = collect_report(&cfg, &mut cpu).await;
        assert_eq!(second.checks.len(), 2);
        assert_eq!(second.checks[1].key, "30-extra");
        assert_eq!(
            second.checks[1].summary.as_deref(),
            Some("fatal: disk offline")
        );
        assert_eq!(second.checks[1].detail.as_deref(), Some("progress step"));
    }

    #[tokio::test]
    async fn supports_toml_dropins_and_script_header_metadata_in_check_dirs() {
        let dir = tempfile::tempdir().unwrap();
        let lib_dir = dir.path().join(".lib");
        std::fs::create_dir(&lib_dir).unwrap();
        let write_file = write_test_file;

        write_file(
            lib_dir.join("unit.sh"),
            "#!/bin/sh\necho \"checked $1 ${2:-}\"\nif [ \"$1\" = \"warn.service\" ]; then exit 2; fi\n",
            true,
        );

        write_file(
            dir.path().join("10-ddclient.toml"),
            r#"
label = "ddclient"
group = "services"
command = ["./.lib/unit.sh", "ddclient.service", "ddclient.timer"]
"#,
            false,
        );

        write_file(
            dir.path().join("20-units.toml"),
            r#"
[[checks]]
key = "warn_svc"
label = "Warn Service"
command = ["./.lib/unit.sh", "warn.service"]

[[checks]]
key = "json_svc"
label = "JSON Service"
command = ["sh", "-c", 'printf "%s" "{\"checks\":[{\"key\":\"inner\",\"label\":\"Inner\",\"status\":\"ok\",\"summary\":\"ready\"}]}"']
"#,
            false,
        );

        write_file(
            dir.path().join("30-reboot.sh"),
            "#!/bin/sh\n# uptarn.key = reboot\n# uptarn.label = \"Kernel\"\n# uptarn.group = system\n# uptarn.warn_exit_code = 3\necho reboot required\nexit 3\n",
            true,
        );

        write_file(
            dir.path().join("40-broken.toml"),
            "unknown_field = 123\n",
            false,
        );

        let mut cfg_file = NamedTempFile::new().unwrap();
        write!(
            cfg_file,
            r#"
hub_url = "https://status.example.com"
node_id = "homelab"
token = "uptn_tok"

[system]
enabled = false

[[check_dirs]]
path = "{dir_path}"
group = "custom"
warn_exit_code = 2
"#,
            dir_path = dir.path().display()
        )
        .unwrap();

        let cfg = AgentConfig::load(cfg_file.path()).unwrap();
        let mut cpu = CpuTracker::default();
        let report = collect_report(&cfg, &mut cpu).await;

        let by_key = |k: &str| {
            report
                .checks
                .iter()
                .find(|c| c.key == k)
                .unwrap_or_else(|| panic!("missing check '{k}': {:?}", report.checks))
        };

        let dd = by_key("10-ddclient");
        assert_eq!(dd.label, "ddclient");
        assert_eq!(dd.group.as_deref(), Some("services"));
        assert_eq!(dd.status, HealthStatus::Ok);
        assert_eq!(
            dd.summary.as_deref(),
            Some("checked ddclient.service ddclient.timer")
        );

        let warn_svc = by_key("warn_svc");
        assert_eq!(warn_svc.label, "Warn Service");
        assert_eq!(warn_svc.group.as_deref(), Some("custom"));
        assert_eq!(warn_svc.status, HealthStatus::Warn);

        let inner = by_key("inner");
        assert_eq!(inner.group.as_deref(), Some("custom"));
        assert_eq!(inner.status, HealthStatus::Ok);

        let reboot = by_key("reboot");
        assert_eq!(reboot.label, "Kernel");
        assert_eq!(reboot.group.as_deref(), Some("system"));
        assert_eq!(reboot.status, HealthStatus::Warn);
        assert_eq!(reboot.summary.as_deref(), Some("reboot required"));

        let broken = by_key("40-broken");
        assert_eq!(broken.status, HealthStatus::Fail);
    }

    #[tokio::test]
    async fn probes_agent_http_tcp_exec_monitors_and_typed_checks() {
        let http_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let http_addr = http_listener.local_addr().unwrap();
        let http_task = tokio::spawn(async move {
            if let Ok((mut stream, _)) = http_listener.accept().await {
                let mut buf = [0u8; 1024];
                let _ = stream.read(&mut buf).await;
                let _ = stream
                    .write_all(
                        b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\nConnection: close\r\n\r\npong",
                    )
                    .await;
            }
        });

        let tcp_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let tcp_addr = tcp_listener.local_addr().unwrap();
        let tcp_task = tokio::spawn(async move {
            for _ in 0..3 {
                let _ = tcp_listener.accept().await;
            }
        });

        let mut cfg_file = NamedTempFile::new().unwrap();
        write!(
            cfg_file,
            r#"
hub_url = "https://status.example.com"
node_id = "homelab"
token = "uptn_tok"
interval_secs = 30
grace_secs = 90

[system]
enabled = false

[[checks]]
type = "tcp"
key = "tcp.local"
label = "Local TCP"
group = "network"
target = "{tcp_addr}"
count = 2

[[monitors]]
key = "blog"
name = "Blog"
url = "https://blog.example.com"

[[monitors]]
key = "immich"
name = "Immich"
from = "agent"
url = "http://{http_addr}/ping"
expected_body = "pong"

[[monitors]]
key = "pg"
name = "PostgreSQL"
type = "tcp"
target = "{tcp_addr}"

[[monitors]]
key = "svc_ok"
name = "Service OK"
type = "exec"
command = ["sh", "-c", "exit 0"]

[[monitors]]
key = "svc_fail"
name = "Service Fail"
type = "exec"
command = ["sh", "-c", "echo unit inactive >&2; exit 3"]
"#
        )
        .unwrap();

        let cfg = AgentConfig::load(cfg_file.path()).unwrap();
        let mut cpu = CpuTracker::default();
        let report = collect_report(&cfg, &mut cpu).await;

        assert_eq!(report.series.len(), 1);
        assert_eq!(report.series[0].key, "tcp.local");
        assert_eq!(report.series[0].status, Some(HealthStatus::Ok));

        let monitors = report.monitors.expect("monitors present");
        assert_eq!(monitors.len(), 5);

        assert!(matches!(
            &monitors[0],
            MonitorSpec::Hub { key, url, .. }
            if key == "blog" && url == "https://blog.example.com"
        ));

        match &monitors[1] {
            MonitorSpec::Agent {
                probe_type,
                target,
                interval_secs,
                grace_secs,
                result,
                ..
            } => {
                assert_eq!(*probe_type, MonitorProbeType::Http);
                assert_eq!(
                    target.as_deref(),
                    Some(format!("http://{http_addr}/ping").as_str())
                );
                assert_eq!(*interval_secs, Some(30));
                assert_eq!(*grace_secs, Some(90));
                let res = result.as_ref().expect("immich result");
                assert!(res.ok);
                assert_eq!(res.http_status, Some(200));
                assert!(res.latency_ms.is_some());
            }
            MonitorSpec::Hub { .. } => panic!("expected agent monitor for immich"),
        }

        match &monitors[2] {
            MonitorSpec::Agent {
                probe_type,
                target,
                result,
                ..
            } => {
                assert_eq!(*probe_type, MonitorProbeType::Tcp);
                assert_eq!(target.as_deref(), Some(tcp_addr.to_string().as_str()));
                let res = result.as_ref().expect("pg result");
                assert!(res.ok);
                assert!(res.latency_ms.is_some());
            }
            MonitorSpec::Hub { .. } => panic!("expected agent monitor for pg"),
        }

        match &monitors[3] {
            MonitorSpec::Agent {
                probe_type,
                target,
                result,
                ..
            } => {
                assert_eq!(*probe_type, MonitorProbeType::Exec);
                assert_eq!(target.as_deref(), Some("sh -c exit 0"));
                let res = result.as_ref().expect("svc_ok result");
                assert!(res.ok);
                assert!(res.latency_ms.is_none());
            }
            MonitorSpec::Hub { .. } => panic!("expected agent monitor for svc_ok"),
        }

        match &monitors[4] {
            MonitorSpec::Agent { result, .. } => {
                let res = result.as_ref().expect("svc_fail result");
                assert!(!res.ok);
                assert_eq!(res.error.as_deref(), Some("unit inactive"));
            }
            MonitorSpec::Hub { .. } => panic!("expected agent monitor for svc_fail"),
        }

        http_task.abort();
        tcp_task.abort();
    }

    #[test]
    fn rejects_invalid_monitor_and_legacy_top_level_configs() {
        let mut legacy = NamedTempFile::new().unwrap();
        write!(
            legacy,
            r#"
hub_url = "https://status.example.com"
node_id = "box"
token = "tok"

[[tcp_probes]]
key = "x"
label = "X"
target = "127.0.0.1:80"
"#
        )
        .unwrap();
        assert!(AgentConfig::load(legacy.path()).is_err());

        let mut hub_tcp = NamedTempFile::new().unwrap();
        write!(
            hub_tcp,
            r#"
hub_url = "https://status.example.com"
node_id = "box"
token = "tok"

[[monitors]]
key = "pg"
name = "PG"
type = "tcp"
from = "hub"
target = "127.0.0.1:5432"
"#
        )
        .unwrap();
        assert!(AgentConfig::load(hub_tcp.path()).is_err());
    }
}
