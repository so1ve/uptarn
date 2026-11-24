mod collect;
mod config;
mod hub;
mod job;
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
    let client = HubClient::from_config(&cfg)?;
    let mut cpu_tracker = CpuTracker::default();
    let mut ticker = tokio::time::interval(Duration::from_secs(cfg.interval_secs.max(10)));
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    loop {
        tokio::select! {
            _ = ticker.tick() => {
                let report = collect_report(&cfg, &mut cpu_tracker).await;
                if let Err(err) = client.post_report(&report).await {
                    eprintln!("uptarn-agent: report push failed: {err:#}");
                }
            }
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

    use super::*;
    use crate::config::parse_duration_secs;

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
    async fn collects_minimal_dsm_and_structured_exec_snapshot() {
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

[[exec]]
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
    async fn discovers_exec_dirs_and_dynamic_mounts_without_reload() {
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
exec_dirs = ["{dir_path}"]

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

        // Drop a new script in without reloading AgentConfig, including a
        // failing script that logs to both stdout and stderr.
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
    async fn supports_toml_dropins_and_script_header_metadata_in_exec_dirs() {
        use crate::protocol::HealthStatus;

        let dir = tempfile::tempdir().unwrap();
        let lib_dir = dir.path().join(".lib");
        std::fs::create_dir(&lib_dir).unwrap();
        let write_file = write_test_file;

        // Shared helper script inside hidden .lib/ (not executed directly).
        write_file(
            lib_dir.join("unit.sh"),
            "#!/bin/sh\necho \"checked $1 ${2:-}\"\nif [ \"$1\" = \"warn.service\" ]; then exit 2; fi\n",
            true,
        );

        // 1. Single-check .toml drop-in with command args, relative ./ path,
        //    and custom metadata.
        write_file(
            dir.path().join("10-ddclient.toml"),
            r#"
label = "ddclient"
group = "services"
command = ["./.lib/unit.sh", "ddclient.service", "ddclient.timer"]
"#,
            false,
        );

        // 2. Multi-check [[exec]] .toml drop-in inheriting directory
        //    warn_exit_code.
        write_file(
            dir.path().join("20-units.toml"),
            r#"
[[exec]]
key = "warn_svc"
label = "Warn Service"
command = ["./.lib/unit.sh", "warn.service"]

[[exec]]
key = "json_svc"
label = "JSON Service"
command = ["sh", "-c", 'printf "%s" "{\"checks\":[{\"key\":\"inner\",\"label\":\"Inner\",\"status\":\"ok\",\"summary\":\"ready\"}]}"']
"#,
            false,
        );

        // 3. Executable script with # uptarn.* header metadata (overrides
        //    key/label/group/warn_exit_code).
        write_file(
            dir.path().join("30-reboot.sh"),
            "#!/bin/sh\n# uptarn.key = reboot\n# uptarn.label = \"Kernel\"\n# uptarn.group = system\n# uptarn.warn_exit_code = 3\necho reboot required\nexit 3\n",
            true,
        );

        // 4. Invalid .toml drop-in surfaces a failed check without breaking
        //    other items.
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

[[exec_dirs]]
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
}
