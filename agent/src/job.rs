use std::fs;
use std::os::unix::process::ExitStatusExt;
use std::process::Stdio;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, ensure};
use reqwest::Client;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::process::Command;

use crate::config::non_empty;

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

fn resolve_ping_url(ping_url: Option<&str>, ping_url_file: Option<&str>) -> Result<String> {
    let raw = if let Some(val) = ping_url.and_then(non_empty) {
        val.to_string()
    } else if let Some(path) = ping_url_file.and_then(non_empty) {
        let content = fs::read_to_string(path).with_context(|| format!("failed to read {path}"))?;
        non_empty(&content)
            .map(str::to_string)
            .with_context(|| format!("ping URL file '{path}' is empty"))?
    } else {
        anyhow::bail!(
            "ping URL is required (pass --ping-url, --ping-url-file, UPTARN_PING_URL, or UPTARN_PING_URL_FILE)"
        );
    };

    let trimmed = raw.trim_end_matches('/').to_string();
    ensure!(
        trimmed.starts_with("http://") || trimmed.starts_with("https://"),
        "ping URL must start with http:// or https://"
    );

    Ok(trimmed)
}

async fn send_ping(
    client: &Client,
    url: &str,
    duration_ms: Option<u64>,
    body: Option<String>,
) -> Result<()> {
    let mut req = client.post(url);
    if let Some(ms) = duration_ms {
        req = req.header("X-Uptarn-Duration-Ms", ms.to_string());
    }
    if let Some(text) = body {
        req = req
            .header("Content-Type", "text/plain; charset=utf-8")
            .body(text);
    }
    let resp = req
        .send()
        .await
        .with_context(|| format!("POST {url} failed"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let err_body = resp.text().await.unwrap_or_default();
        anyhow::bail!("hub rejected ping ({status}): {err_body}");
    }

    Ok(())
}

pub async fn run_job_wrapper(
    ping_url: Option<&str>,
    ping_url_file: Option<&str>,
    cmd_parts: &[String],
) -> Result<i32> {
    let base_url = resolve_ping_url(ping_url, ping_url_file)?;
    let client = Client::builder()
        .timeout(Duration::from_secs(10))
        .user_agent(concat!("uptarn-agent/", env!("CARGO_PKG_VERSION")))
        .build()
        .expect("build reqwest client");

    let (program, args) = cmd_parts
        .split_first()
        .expect("clap requires at least one command argument");

    let start_url = format!("{base_url}/start");
    if let Err(err) = send_ping(&client, &start_url, None, None).await {
        eprintln!("uptarn-agent: warning: failed to report job start: {err:#}");
    }

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
    let (finish_url, body) = if ok {
        (
            base_url,
            Some(format!("completed in {:.1}s", duration_ms as f64 / 1000.0)),
        )
    } else {
        let fail_body = if tail_text.is_empty() {
            match signal {
                Some(sig) => format!("signal {sig}"),
                None => format!("exit {exit_code}"),
            }
        } else {
            tail_text
        };

        (format!("{base_url}/fail"), Some(fail_body))
    };

    if let Err(err) = send_ping(&client, &finish_url, Some(duration_ms), body).await {
        eprintln!("uptarn-agent: warning: failed to report job finish: {err:#}");
    }

    Ok(exit_code)
}
