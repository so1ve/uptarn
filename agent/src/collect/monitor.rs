use std::sync::LazyLock;
use std::time::{Duration, Instant};

use reqwest::Method;
use tokio::net::TcpStream;
use tokio::process::Command;
use tokio::time::timeout;

use crate::config::{MonitorConfig, non_empty};
use crate::protocol::{MonitorProbeFrom, MonitorProbeReport, MonitorProbeType, MonitorSpec};

const MAX_BODY_BYTES: usize = 65_536;
const MAX_ERROR_CHARS: usize = 240;
const MAX_TARGET_CHARS: usize = 120;

static HTTP_PROBE_CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let user_agent = concat!("uptarn-agent-probe/", env!("CARGO_PKG_VERSION"));
    reqwest::Client::builder()
        .user_agent(user_agent)
        .build()
        .unwrap_or_else(|_| {
            // Allow plain HTTP probes in environments without system CA certs
            // (e.g. Nix build sandbox or minimal containers).
            let tls = rustls::ClientConfig::builder()
                .with_root_certificates(rustls::RootCertStore::empty())
                .with_no_client_auth();
            reqwest::Client::builder()
                .user_agent(user_agent)
                .tls_backend_preconfigured(tls)
                .build()
                .expect("build fallback HTTP probe client")
        })
});

fn round1(value: f64) -> f64 {
    (value * 10.0).round() / 10.0
}

fn truncate_chars(text: &str, max_chars: usize) -> String {
    let trimmed = text.trim();
    if trimmed.chars().count() <= max_chars {
        return trimmed.to_string();
    }

    trimmed.chars().take(max_chars).collect()
}

fn timeout_label(timeout_ms: u64) -> String {
    if timeout_ms >= 1000 && timeout_ms.is_multiple_of(1000) {
        format!("{}s", timeout_ms / 1000)
    } else {
        format!("{timeout_ms}ms")
    }
}

fn format_command_preview(command: &[String]) -> String {
    let joined = command.join(" ");

    truncate_chars(&joined, MAX_TARGET_CHARS)
}

async fn read_bounded_text(
    mut response: reqwest::Response,
    max_bytes: usize,
) -> Result<String, reqwest::Error> {
    let mut buf = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        let remaining = max_bytes.saturating_sub(buf.len());
        if remaining == 0 {
            break;
        }
        let take = chunk.len().min(remaining);
        buf.extend_from_slice(&chunk[..take]);
        if buf.len() >= max_bytes {
            break;
        }
    }

    Ok(String::from_utf8_lossy(&buf).into_owned())
}

async fn probe_http(cfg: &MonitorConfig) -> MonitorProbeReport {
    let Some(url) = cfg.url.as_deref().and_then(non_empty) else {
        return MonitorProbeReport {
            ok: false,
            latency_ms: None,
            http_status: None,
            error: Some("Missing HTTP URL".to_string()),
        };
    };
    let method_str = cfg
        .method
        .as_deref()
        .and_then(non_empty)
        .unwrap_or("GET")
        .to_ascii_uppercase();
    let method = Method::from_bytes(method_str.as_bytes()).unwrap_or(Method::GET);
    let timeout_ms = cfg.timeout_ms.unwrap_or_else(|| cfg.default_timeout_ms());
    let min_status = cfg.expected_status_min.unwrap_or(200);
    let max_status = cfg
        .expected_status_max
        .unwrap_or_else(|| min_status.max(299));

    let started = Instant::now();
    let response = match HTTP_PROBE_CLIENT
        .request(method, url)
        .timeout(Duration::from_millis(timeout_ms))
        .send()
        .await
    {
        Ok(resp) => resp,
        Err(err) => {
            let latency_ms = Some(round1(started.elapsed().as_secs_f64() * 1000.0));
            let error = if err.is_timeout() {
                format!("Timed out after {}", timeout_label(timeout_ms))
            } else {
                truncate_chars(&err.to_string(), MAX_ERROR_CHARS)
            };

            return MonitorProbeReport {
                ok: false,
                latency_ms,
                http_status: None,
                error: Some(error),
            };
        }
    };

    let status = response.status().as_u16();
    let latency_ms = Some(round1(started.elapsed().as_secs_f64() * 1000.0));
    if status < min_status || status > max_status {
        return MonitorProbeReport {
            ok: false,
            latency_ms,
            http_status: Some(status),
            error: Some(format!("HTTP {status}")),
        };
    }

    if let Some(expected_body) = cfg.expected_body.as_deref().and_then(non_empty) {
        match read_bounded_text(response, MAX_BODY_BYTES).await {
            Ok(body) => {
                if !body.contains(expected_body) {
                    let preview = truncate_chars(expected_body, 48);

                    return MonitorProbeReport {
                        ok: false,
                        latency_ms,
                        http_status: Some(status),
                        error: Some(format!("Body missing \"{preview}\"")),
                    };
                }
            }
            Err(err) => {
                let error = if err.is_timeout() {
                    format!("Timed out after {}", timeout_label(timeout_ms))
                } else {
                    truncate_chars(&err.to_string(), MAX_ERROR_CHARS)
                };

                return MonitorProbeReport {
                    ok: false,
                    latency_ms,
                    http_status: Some(status),
                    error: Some(error),
                };
            }
        }
    }

    MonitorProbeReport {
        ok: true,
        latency_ms,
        http_status: Some(status),
        error: None,
    }
}

async fn probe_tcp(cfg: &MonitorConfig) -> MonitorProbeReport {
    let Some(target) = cfg.target.as_deref().and_then(non_empty) else {
        return MonitorProbeReport {
            ok: false,
            latency_ms: None,
            http_status: None,
            error: Some("Missing TCP target".to_string()),
        };
    };
    let timeout_ms = cfg.timeout_ms.unwrap_or_else(|| cfg.default_timeout_ms());
    let started = Instant::now();

    match timeout(
        Duration::from_millis(timeout_ms),
        TcpStream::connect(target),
    )
    .await
    {
        Ok(Ok(_stream)) => MonitorProbeReport {
            ok: true,
            latency_ms: Some(round1(started.elapsed().as_secs_f64() * 1000.0)),
            http_status: None,
            error: None,
        },
        Ok(Err(err)) => MonitorProbeReport {
            ok: false,
            latency_ms: Some(round1(started.elapsed().as_secs_f64() * 1000.0)),
            http_status: None,
            error: Some(truncate_chars(&err.to_string(), MAX_ERROR_CHARS)),
        },
        Err(_) => MonitorProbeReport {
            ok: false,
            latency_ms: Some(round1(started.elapsed().as_secs_f64() * 1000.0)),
            http_status: None,
            error: Some(format!("Timed out after {}", timeout_label(timeout_ms))),
        },
    }
}

async fn probe_exec(cfg: &MonitorConfig) -> MonitorProbeReport {
    let Some((program, args)) = cfg.command.split_first() else {
        return MonitorProbeReport {
            ok: false,
            latency_ms: None,
            http_status: None,
            error: Some("Empty command".to_string()),
        };
    };
    let timeout_ms = cfg.timeout_ms.unwrap_or_else(|| cfg.default_timeout_ms());

    let mut cmd = Command::new(program);
    cmd.args(args).kill_on_drop(true);
    let output = match timeout(Duration::from_millis(timeout_ms), cmd.output()).await {
        Ok(Ok(out)) => out,
        Ok(Err(err)) => {
            return MonitorProbeReport {
                ok: false,
                latency_ms: None,
                http_status: None,
                error: Some(truncate_chars(
                    &format!("spawn failed: {err}"),
                    MAX_ERROR_CHARS,
                )),
            };
        }
        Err(_) => {
            return MonitorProbeReport {
                ok: false,
                latency_ms: None,
                http_status: None,
                error: Some(format!("Timed out after {}", timeout_label(timeout_ms))),
            };
        }
    };

    if output.status.success() {
        return MonitorProbeReport {
            ok: true,
            latency_ms: None,
            http_status: None,
            error: None,
        };
    }

    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    let first_line = stderr
        .lines()
        .chain(stdout.lines())
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(|line| truncate_chars(line, MAX_ERROR_CHARS))
        .unwrap_or_else(|| format!("exit {}", output.status.code().unwrap_or(-1)));

    MonitorProbeReport {
        ok: false,
        latency_ms: None,
        http_status: None,
        error: Some(first_line),
    }
}

pub async fn collect_monitor(
    cfg: &MonitorConfig,
    node_interval_secs: u64,
    node_grace_secs: Option<u64>,
) -> MonitorSpec {
    if cfg.resolved_from() == MonitorProbeFrom::Hub {
        return MonitorSpec::Hub {
            key: cfg.key.clone(),
            name: cfg.name.clone(),
            url: cfg.url.clone().unwrap_or_default(),
            public_url: cfg.public_url.clone(),
            method: cfg.method.clone(),
            expected_status_min: cfg.expected_status_min,
            expected_status_max: cfg.expected_status_max,
            expected_body: cfg.expected_body.clone(),
            timeout_ms: cfg.timeout_ms,
            interval_secs: cfg.interval_secs,
            enabled: cfg.enabled,
            is_public: cfg.is_public,
        };
    }

    let enabled = cfg.enabled.unwrap_or(true);
    let result = if enabled {
        Some(match cfg.probe_type {
            MonitorProbeType::Http => probe_http(cfg).await,
            MonitorProbeType::Tcp => probe_tcp(cfg).await,
            MonitorProbeType::Exec => probe_exec(cfg).await,
        })
    } else {
        None
    };

    let target = match cfg.probe_type {
        MonitorProbeType::Http => cfg.url.clone(),
        MonitorProbeType::Tcp => cfg.target.clone(),
        MonitorProbeType::Exec => cfg
            .target
            .as_deref()
            .and_then(non_empty)
            .map(str::to_string)
            .or_else(|| Some(format_command_preview(&cfg.command))),
    };

    MonitorSpec::Agent {
        key: cfg.key.clone(),
        name: cfg.name.clone(),
        probe_type: cfg.probe_type,
        target,
        public_url: cfg.public_url.clone(),
        interval_secs: cfg.interval_secs.or(Some(node_interval_secs)),
        grace_secs: cfg.grace_secs.or(node_grace_secs),
        enabled: cfg.enabled,
        is_public: cfg.is_public,
        result,
    }
}
