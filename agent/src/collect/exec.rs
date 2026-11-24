use std::fs;
use std::io::ErrorKind;
use std::os::unix::fs::PermissionsExt;
use std::time::Duration;

use tokio::process::Command;
use tokio::time::timeout;

use crate::config::{ExecCheckConfig, ExecDirConfig, ExecOutputFormat};
use crate::protocol::{CheckSnapshot, HealthStatus, StructuredExecOutput};

fn failed_exec(
    cfg: &ExecCheckConfig,
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

fn sanitize_slug(stem: &str) -> String {
    let mut slug: String = stem
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | ':' | '-') {
                c
            } else {
                '_'
            }
        })
        .take(64)
        .collect();
    if !slug.starts_with(|c: char| c.is_ascii_alphanumeric()) {
        slug.insert(0, 'x');
        slug.truncate(64);
    }

    slug
}

pub fn discover_exec_dirs(dirs: &[ExecDirConfig]) -> (Vec<ExecCheckConfig>, Vec<CheckSnapshot>) {
    let mut discovered = Vec::new();
    let mut errors = Vec::new();

    for entry in dirs {
        let (dir_path, group, format, timeout_ms) = entry.parts();
        let read_dir = match fs::read_dir(dir_path) {
            Ok(rd) => rd,
            Err(err) if err.kind() == ErrorKind::NotFound => continue,
            Err(err) => {
                errors.push(CheckSnapshot::failed(
                    sanitize_slug(&format!("exec_dir_{dir_path}")),
                    format!("exec_dir {dir_path}"),
                    group.map(str::to_string),
                    format!("failed to read directory: {err}"),
                    None,
                ));
                continue;
            }
        };

        let mut paths: Vec<_> = read_dir
            .filter_map(Result::ok)
            .map(|e| e.path())
            .filter(|p| {
                p.file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| !n.starts_with('.'))
            })
            .filter(|p| {
                fs::metadata(p).is_ok_and(|m| m.is_file() && (m.permissions().mode() & 0o111) != 0)
            })
            .collect();
        paths.sort();

        for path in paths {
            let stem = path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("collector");
            discovered.push(ExecCheckConfig {
                key: sanitize_slug(stem),
                label: stem.to_string(),
                group: group.map(str::to_string),
                command: vec![path.to_string_lossy().into_owned()],
                format,
                warn_exit_code: None,
                timeout_ms,
            });
        }
    }

    (discovered, errors)
}

pub async fn collect_exec_item(cfg: &ExecCheckConfig) -> StructuredExecOutput {
    let Some((program, args)) = cfg.command.split_first() else {
        return failed_exec(cfg, "empty command in [[exec]]", None);
    };

    let mut cmd = Command::new(program);
    cmd.args(args).kill_on_drop(true);
    let output = match timeout(Duration::from_millis(cfg.timeout_ms), cmd.output()).await {
        Ok(Ok(out)) => out,
        Ok(Err(err)) => return failed_exec(cfg, format!("spawn failed: {err}"), None),
        Err(_) => {
            return failed_exec(cfg, format!("timed out after {}ms", cfg.timeout_ms), None);
        }
    };

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();

    if cfg.format == ExecOutputFormat::Json
        || (cfg.format == ExecOutputFormat::Auto && stdout.starts_with('{'))
    {
        let mut parsed = match serde_json::from_str::<StructuredExecOutput>(&stdout) {
            Ok(parsed) => parsed,
            Err(err) => {
                return failed_exec(
                    cfg,
                    format!("invalid exec JSON: {err}"),
                    Some(stdout.chars().take(1024).collect()),
                );
            }
        };

        let empty_payload = parsed.mounts.is_empty()
            && parsed.checks.is_empty()
            && parsed.series.is_empty()
            && parsed.info.is_empty();
        if parsed.status.is_some() || empty_payload {
            parsed.checks.insert(
                0,
                CheckSnapshot {
                    key: cfg.key.clone(),
                    label: cfg.label.clone(),
                    group: cfg.group.clone(),
                    status: parsed.status.unwrap_or(if output.status.success() {
                        HealthStatus::Ok
                    } else {
                        HealthStatus::Fail
                    }),
                    summary: parsed.summary.take(),
                    detail: parsed.detail.take(),
                },
            );
        }

        return parsed;
    }

    let code = output.status.code();
    let status = if output.status.success() {
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
