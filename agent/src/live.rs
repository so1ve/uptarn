use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use futures_util::{SinkExt, StreamExt};
use tokio::time::MissedTickBehavior;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;

use crate::collect::{CpuTracker, collect_live_frame};
use crate::config::AgentConfig;

const MIN_BACKOFF_SECS: u64 = 2;
const MAX_BACKOFF_SECS: u64 = 60;
const STABLE_SESSION_SECS: u64 = 30;
const CONNECT_TIMEOUT_SECS: u64 = 12;
const SEND_TIMEOUT_SECS: u64 = 10;

fn build_live_ws_url(hub_url: &str, node_id: &str) -> Result<String> {
    let ws_base = if let Some(rest) = hub_url.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = hub_url.strip_prefix("http://") {
        format!("ws://{rest}")
    } else {
        bail!("hub_url must start with http:// or https://");
    };

    Ok(format!("{ws_base}/api/v1/ingest/live?node_id={node_id}"))
}

async fn run_live_session(
    cfg: &AgentConfig,
    token: &str,
    cpu_tracker: &mut CpuTracker,
) -> Result<()> {
    let url = build_live_ws_url(&cfg.hub_url, &cfg.node_id)?;
    let mut request = url.into_client_request().context("invalid live WS URL")?;
    let auth = HeaderValue::from_str(&format!("Bearer {token}"))
        .context("invalid Authorization header")?;
    request.headers_mut().insert("Authorization", auth);
    request.headers_mut().insert(
        "User-Agent",
        HeaderValue::from_static(concat!("uptarn-agent/", env!("CARGO_PKG_VERSION"))),
    );

    let (ws_stream, _) = tokio::time::timeout(
        Duration::from_secs(CONNECT_TIMEOUT_SECS),
        connect_async(request),
    )
    .await
    .context("live WS connect timed out")?
    .context("live WS connect failed")?;

    let (mut sink, mut stream) = ws_stream.split();
    let mut ticker = tokio::time::interval(Duration::from_secs(cfg.live_interval_secs.max(1)));
    ticker.set_missed_tick_behavior(MissedTickBehavior::Delay);

    loop {
        tokio::select! {
            _ = ticker.tick() => {
                let frame = collect_live_frame(&cfg.system, cpu_tracker).await;
                let payload = serde_json::to_string(&frame)?;
                tokio::time::timeout(
                    Duration::from_secs(SEND_TIMEOUT_SECS),
                    sink.send(Message::Text(payload.into())),
                )
                .await
                .context("live WS send timed out")?
                .context("live WS send failed")?;
            }
            incoming = stream.next() => {
                match incoming {
                    Some(Ok(Message::Ping(data))) => {
                        sink.send(Message::Pong(data))
                            .await
                            .context("live WS pong failed")?;
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Err(err)) => return Err(err).context("live WS read failed"),
                    // Strictly one-way: ignore any server text/binary frames.
                    Some(Ok(_)) => {}
                }
            }
        }
    }

    Ok(())
}

pub async fn run_live_loop(cfg: AgentConfig, token: String) {
    let mut cpu_tracker = CpuTracker::default();
    let mut backoff_secs = MIN_BACKOFF_SECS;

    loop {
        let started = Instant::now();
        if let Err(err) = run_live_session(&cfg, &token, &mut cpu_tracker).await {
            eprintln!("uptarn-agent: live stream disconnected: {err:#}");
        }
        if started.elapsed() >= Duration::from_secs(STABLE_SESSION_SECS) {
            backoff_secs = MIN_BACKOFF_SECS;
        }
        tokio::time::sleep(Duration::from_secs(backoff_secs)).await;
        backoff_secs = (backoff_secs * 2).min(MAX_BACKOFF_SECS);
    }
}

#[cfg(test)]
mod tests {
    use super::build_live_ws_url;

    #[test]
    fn converts_http_and_https_hub_urls_to_websocket_endpoints() {
        assert_eq!(
            build_live_ws_url("https://status.example.com", "vps-jp").unwrap(),
            "wss://status.example.com/api/v1/ingest/live?node_id=vps-jp"
        );
        assert_eq!(
            build_live_ws_url("http://127.0.0.1:8787", "local").unwrap(),
            "ws://127.0.0.1:8787/api/v1/ingest/live?node_id=local"
        );
        assert!(build_live_ws_url("ftp://bad", "x").is_err());
    }
}
