use std::os::unix::process::ExitStatusExt;
use std::path::Path;
use std::process::Stdio;
use std::time::Instant;

use anyhow::{Context, Result};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::process::Command;

use crate::config::{AgentConfig, parse_duration_secs};
use crate::hub::HubClient;
use crate::protocol::JobReportPayload;

const TAIL_CAP_BYTES: usize = 2048;

fn append_capped_tail(buf: &mut Vec<u8>, chunk: &[u8]) {
    buf.extend_from_slice(chunk);
    if buf.len() > TAIL_CAP_BYTES {
        let excess = buf.len() - TAIL_CAP_BYTES;
        buf.drain(..excess);
    }
}

async fn pump_stream<R, W>(mut reader: R, mut writer: W) -> Vec<u8>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let mut tail = Vec::new();
    let mut chunk = [0u8; 4096];
    while let Ok(n) = reader.read(&mut chunk).await {
        if n == 0 {
            break;
        }
        append_capped_tail(&mut tail, &chunk[..n]);
        let _ = writer.write_all(&chunk[..n]).await;
    }

    tail
}

pub async fn run_job_wrapper(
    config_path: &Path,
    job_key: String,
    label: Option<String>,
    every: &str,
    grace: &str,
    cmd_parts: &[String],
) -> Result<i32> {
    let cfg = AgentConfig::load(config_path)?;
    let interval_secs = parse_duration_secs(every)?;
    let grace_secs = parse_duration_secs(grace)?;
    let node_id = Some(cfg.node_id.clone());
    let client = HubClient::from_config(&cfg)?;

    let (program, args) = cmd_parts
        .split_first()
        .expect("clap requires at least one command argument");

    let started = Instant::now();
    let mut child = Command::new(program)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .with_context(|| format!("failed to spawn '{program}'"))?;

    let out_task = tokio::spawn(pump_stream(
        child.stdout.take().unwrap(),
        tokio::io::stdout(),
    ));
    let err_task = tokio::spawn(pump_stream(
        child.stderr.take().unwrap(),
        tokio::io::stderr(),
    ));

    let status = child
        .wait()
        .await
        .context("failed waiting for job command")?;

    let mut combined_tail = out_task.await.unwrap();
    append_capped_tail(&mut combined_tail, &err_task.await.unwrap());

    let duration_ms = started.elapsed().as_millis() as u64;
    let signal = status.signal();
    let exit_code = status
        .code()
        .or_else(|| signal.map(|sig| 128 + sig))
        .unwrap_or(1);
    let tail_text = String::from_utf8_lossy(&combined_tail).trim().to_string();

    let ok = status.success();
    let summary = if ok {
        format!("completed in {:.1}s", duration_ms as f64 / 1000.0)
    } else {
        let prefix = match signal {
            Some(sig) => format!("signal {sig}"),
            None => format!("exit {exit_code}"),
        };
        if tail_text.is_empty() {
            prefix
        } else {
            let last_line = tail_text.lines().last().unwrap_or_default();
            format!("{prefix}: {last_line}")
        }
    };

    let payload = JobReportPayload {
        job_key,
        node_id,
        label,
        interval_secs,
        grace_secs: Some(grace_secs),
        status: if ok { "ok" } else { "fail" },
        duration_ms: Some(duration_ms),
        summary: Some(summary),
        detail: (!ok && !tail_text.is_empty()).then_some(tail_text),
    };

    if let Err(err) = client.post_job(&payload).await {
        eprintln!("uptarn-agent: warning: failed to report job heartbeat: {err:#}");
    }

    Ok(exit_code)
}
