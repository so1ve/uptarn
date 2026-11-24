use std::fs;
use std::path::Path;

use anyhow::{Context, Result, bail, ensure};
use serde::Deserialize;

use crate::protocol::InfoSnapshot;

const EXEC_TIMEOUT_MS: u64 = 5000;

const fn default_exec_timeout_ms() -> u64 {
    EXEC_TIMEOUT_MS
}

const fn default_auto_format() -> ExecOutputFormat {
    ExecOutputFormat::Auto
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct AgentConfig {
    pub hub_url: String,
    pub node_id: String,
    pub label: Option<String>,
    pub token: Option<String>,
    pub token_file: Option<String>,
    pub enroll_token: Option<String>,
    pub enroll_token_file: Option<String>,
    pub interval_secs: u64,
    pub grace_secs: Option<u64>,
    pub system: SystemCollectConfig,
    pub mounts: Vec<MountConfig>,
    pub tcp_probes: Vec<TcpProbeConfig>,
    pub tls_certs: Vec<TlsCertConfig>,
    pub exec: Vec<ExecCheckConfig>,
    pub exec_dirs: Vec<ExecDirConfig>,
    pub info: Vec<InfoSnapshot>,
}

impl Default for AgentConfig {
    fn default() -> Self {
        Self {
            hub_url: String::new(),
            node_id: String::new(),
            label: None,
            token: None,
            token_file: None,
            enroll_token: None,
            enroll_token_file: None,
            interval_secs: 60,
            grace_secs: None,
            system: SystemCollectConfig::default(),
            mounts: Vec::new(),
            tcp_probes: Vec::new(),
            tls_certs: Vec::new(),
            exec: Vec::new(),
            exec_dirs: Vec::new(),
            info: Vec::new(),
        }
    }
}

#[expect(
    clippy::struct_excessive_bools,
    reason = "Independent per-metric TOML switches in [system]"
)]
#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct SystemCollectConfig {
    pub enabled: bool,
    pub cpu: bool,
    pub memory: bool,
    pub load: bool,
    pub network: bool,
    pub os_info: bool,
    pub interfaces: Vec<String>,
}

impl Default for SystemCollectConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            cpu: true,
            memory: true,
            load: true,
            network: true,
            os_info: true,
            interfaces: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct MountConfig {
    pub path: String,
    pub label: Option<String>,
    pub warn_pct: f64,
    pub fail_pct: f64,
    pub timeout_ms: u64,
}

impl Default for MountConfig {
    fn default() -> Self {
        Self {
            path: String::new(),
            label: None,
            warn_pct: 85.0,
            fail_pct: 92.0,
            timeout_ms: 3000,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct TcpProbeConfig {
    pub key: String,
    pub label: String,
    pub group: Option<String>,
    pub target: String,
    pub count: u32,
    pub timeout_ms: u64,
    pub warn_ms: f64,
    pub fail_ms: f64,
    pub warn_loss_pct: f64,
    pub fail_loss_pct: f64,
}

impl Default for TcpProbeConfig {
    fn default() -> Self {
        Self {
            key: String::new(),
            label: String::new(),
            group: None,
            target: String::new(),
            count: 4,
            timeout_ms: 2000,
            warn_ms: 250.0,
            fail_ms: 800.0,
            warn_loss_pct: 20.0,
            fail_loss_pct: 50.0,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct TlsCertConfig {
    pub key: String,
    pub label: String,
    pub group: Option<String>,
    pub path: Option<String>,
    pub connect: Option<String>,
    pub server_name: Option<String>,
    pub warn_days: i64,
    pub fail_days: i64,
    pub timeout_ms: u64,
}

impl Default for TlsCertConfig {
    fn default() -> Self {
        Self {
            key: String::new(),
            label: String::new(),
            group: None,
            path: None,
            connect: None,
            server_name: None,
            warn_days: 14,
            fail_days: 5,
            timeout_ms: 2000,
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExecOutputFormat {
    #[default]
    Exit,
    Json,
    Auto,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum ExecDirConfig {
    Path(String),
    Detailed {
        path: String,
        group: Option<String>,
        #[serde(default = "default_auto_format")]
        format: ExecOutputFormat,
        #[serde(default = "default_exec_timeout_ms")]
        timeout_ms: u64,
    },
}

impl ExecDirConfig {
    pub fn parts(&self) -> (&str, Option<&str>, ExecOutputFormat, u64) {
        match self {
            Self::Path(path) => (path.as_str(), None, ExecOutputFormat::Auto, EXEC_TIMEOUT_MS),
            Self::Detailed {
                path,
                group,
                format,
                timeout_ms,
            } => (path.as_str(), group.as_deref(), *format, *timeout_ms),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct ExecCheckConfig {
    pub key: String,
    pub label: String,
    pub group: Option<String>,
    pub command: Vec<String>,
    pub format: ExecOutputFormat,
    pub warn_exit_code: Option<i32>,
    pub timeout_ms: u64,
}

impl Default for ExecCheckConfig {
    fn default() -> Self {
        Self {
            key: String::new(),
            label: String::new(),
            group: None,
            command: Vec::new(),
            format: ExecOutputFormat::Exit,
            warn_exit_code: None,
            timeout_ms: EXEC_TIMEOUT_MS,
        }
    }
}

fn non_empty(value: &str) -> Option<String> {
    let trimmed = value.trim();

    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

fn resolve_secret(
    inline: Option<&str>,
    file: Option<&str>,
    env_var: &str,
) -> Result<Option<String>> {
    if let Some(val) = inline.and_then(non_empty) {
        return Ok(Some(val));
    }
    if let Some(path) = file {
        let content = fs::read_to_string(path).with_context(|| format!("failed to read {path}"))?;
        if let Some(val) = non_empty(&content) {
            return Ok(Some(val));
        }
    }
    if let Ok(env_val) = std::env::var(env_var)
        && let Some(val) = non_empty(&env_val)
    {
        return Ok(Some(val));
    }

    Ok(None)
}

impl AgentConfig {
    pub fn load(path: &Path) -> Result<Self> {
        let raw = fs::read_to_string(path)
            .with_context(|| format!("failed to read config {}", path.display()))?;
        let mut cfg: Self = toml::from_str(&raw)
            .with_context(|| format!("failed to parse TOML config {}", path.display()))?;
        cfg.hub_url = cfg.hub_url.trim().trim_end_matches('/').to_string();
        ensure!(!cfg.hub_url.is_empty(), "hub_url cannot be empty");
        for m in &cfg.mounts {
            ensure!(!m.path.trim().is_empty(), "mounts[].path cannot be empty");
        }
        for p in &cfg.tcp_probes {
            ensure!(
                !p.key.trim().is_empty() && !p.target.trim().is_empty(),
                "tcp_probes[] requires key and target"
            );
        }
        for c in &cfg.tls_certs {
            ensure!(
                !c.key.trim().is_empty() && (c.path.is_some() || c.connect.is_some()),
                "tls_certs[] requires key and either path or connect"
            );
        }
        for e in &cfg.exec {
            ensure!(
                !e.key.trim().is_empty() && !e.command.is_empty(),
                "exec[] requires key and command"
            );
        }

        cfg.node_id = non_empty(&cfg.node_id)
            .or_else(|| non_empty(&rustix::system::uname().nodename().to_string_lossy()))
            .context("node_id is unset and system hostname could not be determined")?;

        Ok(cfg)
    }

    pub fn resolved_token(&self) -> Result<String> {
        resolve_secret(
            self.token.as_deref(),
            self.token_file.as_deref(),
            "UPTARN_TOKEN",
        )?
        .context("Bearer token is required (set token, token_file, or UPTARN_TOKEN)")
    }

    pub fn resolved_enroll_token(&self) -> Result<Option<String>> {
        resolve_secret(
            self.enroll_token.as_deref(),
            self.enroll_token_file.as_deref(),
            "UPTARN_ENROLL_TOKEN",
        )
    }
}

pub fn parse_duration_secs(raw: &str) -> Result<u64> {
    let s = raw.trim();
    if s.is_empty() {
        bail!("duration cannot be empty");
    }

    let (num_str, mult) = match s.as_bytes().last() {
        Some(b'd' | b'D') => (&s[..s.len() - 1], 86_400u64),
        Some(b'h' | b'H') => (&s[..s.len() - 1], 3600u64),
        Some(b'm' | b'M') => (&s[..s.len() - 1], 60u64),
        Some(b's' | b'S') => (&s[..s.len() - 1], 1u64),
        _ => (s, 1u64),
    };

    let base: u64 = num_str
        .trim()
        .parse()
        .with_context(|| format!("invalid duration '{raw}'"))?;

    Ok(base.saturating_mul(mult))
}
