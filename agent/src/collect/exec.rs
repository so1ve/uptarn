use std::io;
use std::process::{ExitStatus, Output};
use std::time::Duration;

use tokio::process::Command;
use tokio::time::{sleep, timeout};

const ETXTBSY_MAX_RETRIES: u32 = 5;

pub(super) async fn run_command_output(
    program: &str,
    args: &[String],
    timeout_ms: u64,
) -> Result<io::Result<Output>, tokio::time::error::Elapsed> {
    timeout(Duration::from_millis(timeout_ms), async {
        let mut attempt = 0u32;
        loop {
            let mut cmd = Command::new(program);
            cmd.args(args).kill_on_drop(true);
            match cmd.output().await {
                Err(err)
                    if err.kind() == io::ErrorKind::ExecutableFileBusy
                        && attempt < ETXTBSY_MAX_RETRIES =>
                {
                    attempt += 1;
                    sleep(Duration::from_millis(10 * u64::from(attempt))).await;
                }
                result => return result,
            }
        }
    })
    .await
}

use crate::config::{ExecCollectorConfig, ExecOutputFormat};
use crate::protocol::{CheckSnapshot, HealthStatus, StructuredExecOutput};

fn failed_exec(
    cfg: &ExecCollectorConfig,
    summary: impl Into<String>,
    detail: Option<String>,
) -> StructuredExecOutput {
    StructuredExecOutput {
        checks: vec![CheckSnapshot::failed(
            cfg.key.clone(),
            cfg.label.clone(),
            cfg.group.clone(),
            summary,
            detail,
        )],
        ..Default::default()
    }
}

fn parse_json_output(
    cfg: &ExecCollectorConfig,
    stdout: &str,
    exit_status: ExitStatus,
) -> StructuredExecOutput {
    let mut parsed = match serde_json::from_str::<StructuredExecOutput>(stdout) {
        Ok(parsed) => parsed,
        Err(err) => {
            return failed_exec(
                cfg,
                format!("invalid exec JSON: {err}"),
                Some(stdout.chars().take(1024).collect()),
            );
        }
    };

    if let Some(group) = &cfg.group {
        parsed.apply_default_group(group);
    }

    if parsed.status.is_some() || parsed.is_empty() {
        parsed.checks.insert(
            0,
            CheckSnapshot {
                key: cfg.key.clone(),
                label: cfg.label.clone(),
                group: cfg.group.clone(),
                status: parsed.status.unwrap_or(if exit_status.success() {
                    HealthStatus::Ok
                } else {
                    HealthStatus::Fail
                }),
                summary: parsed.summary.take(),
                detail: parsed.detail.take(),
            },
        );
    }

    parsed
}

fn parse_exit_output(
    cfg: &ExecCollectorConfig,
    stdout: String,
    stderr: String,
    exit_status: ExitStatus,
) -> StructuredExecOutput {
    let code = exit_status.code();
    let status = if exit_status.success() {
        HealthStatus::Ok
    } else if cfg.warn_exit_code.is_some() && code == cfg.warn_exit_code {
        HealthStatus::Warn
    } else {
        HealthStatus::Fail
    };

    let (summary_source, extra_detail) = if status != HealthStatus::Ok && !stderr.is_empty() {
        let detail = (!stdout.is_empty()).then_some(stdout);

        (stderr, detail)
    } else {
        let combined = if stdout.is_empty() { stderr } else { stdout };

        (combined, None)
    };
    let mut lines = summary_source.lines();
    let first_line = lines.next().map(|l| l.trim().to_string());
    let mut rest = lines.collect::<Vec<_>>().join("\n");
    if let Some(extra) = extra_detail {
        if !rest.is_empty() {
            rest.push('\n');
        }
        rest.push_str(&extra);
    }

    StructuredExecOutput {
        checks: vec![CheckSnapshot {
            key: cfg.key.clone(),
            label: cfg.label.clone(),
            group: cfg.group.clone(),
            status,
            summary: first_line.or_else(|| {
                Some(if status == HealthStatus::Ok {
                    "ok".to_string()
                } else {
                    format!("exit {}", code.unwrap_or(-1))
                })
            }),
            detail: (!rest.is_empty()).then(|| rest.chars().take(2048).collect()),
        }],
        ..Default::default()
    }
}

pub async fn collect_item(cfg: &ExecCollectorConfig) -> StructuredExecOutput {
    let Some((program, args)) = cfg.command.split_first() else {
        return failed_exec(cfg, "empty command in [[checks]]", None);
    };

    let output = match run_command_output(program, args, cfg.timeout_ms).await {
        Ok(Ok(out)) => out,
        Ok(Err(err)) => return failed_exec(cfg, format!("spawn failed: {err}"), None),
        Err(_) => {
            return failed_exec(cfg, format!("timed out after {}ms", cfg.timeout_ms), None);
        }
    };

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if cfg.format == ExecOutputFormat::Json
        || (cfg.format == ExecOutputFormat::Auto && stdout.starts_with('{'))
    {
        return parse_json_output(cfg, &stdout, output.status);
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();

    parse_exit_output(cfg, stdout, stderr, output.status)
}
