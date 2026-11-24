use std::fs;
use std::path::Path;
use std::str::FromStr;

use anyhow::{Context, Result, bail, ensure};
use serde::Deserialize;

use crate::protocol::{InfoSnapshot, MonitorSpec};

const EXEC_TIMEOUT_MS: u64 = 5000;

const fn default_u32<const V: u32>() -> u32 {
    V
}
const fn default_u64<const V: u64>() -> u64 {
    V
}
const fn default_i64<const V: i64>() -> i64 {
    V
}
const fn default_f64<const V: u32>() -> f64 {
    V as f64
}
const fn default_auto_format() -> ExecOutputFormat {
    ExecOutputFormat::Auto
}

#[derive(Debug, Clone, Deserialize)]
pub struct AgentConfig {
    #[serde(default)]
    pub hub_url: String,
    #[serde(default)]
    pub node_id: String,
    pub label: Option<String>,
    pub token: Option<String>,
    pub token_file: Option<String>,
    pub enroll_token: Option<String>,
    pub enroll_token_file: Option<String>,
    #[serde(default = "default_u64::<60>")]
    pub interval_secs: u64,
    pub grace_secs: Option<u64>,
    pub is_public: Option<bool>,
    #[serde(default)]
    pub system: SystemCollectConfig,
    #[serde(default)]
    pub mounts: Vec<MountConfig>,
    #[serde(default)]
    pub tcp_probes: Vec<TcpProbeConfig>,
    #[serde(default)]
    pub tls_certs: Vec<TlsCertConfig>,
    #[serde(default)]
    pub exec: Vec<ExecCheckConfig>,
    #[serde(default)]
    pub exec_dirs: Vec<ExecDirConfig>,
    #[serde(default)]
    pub info: Vec<InfoSnapshot>,
    pub monitors: Option<Vec<MonitorSpec>>,
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
    pub temperature: bool,
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
            temperature: true,
            os_info: true,
            interfaces: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct MountConfig {
    #[serde(default)]
    pub path: String,
    pub label: Option<String>,
    #[serde(default = "default_f64::<85>")]
    pub warn_pct: f64,
    #[serde(default = "default_f64::<92>")]
    pub fail_pct: f64,
    #[serde(default = "default_u64::<3000>")]
    pub timeout_ms: u64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct TcpProbeConfig {
    #[serde(default)]
    pub key: String,
    #[serde(default)]
    pub label: String,
    pub group: Option<String>,
    #[serde(default)]
    pub target: String,
    #[serde(default = "default_u32::<4>")]
    pub count: u32,
    #[serde(default = "default_u64::<2000>")]
    pub timeout_ms: u64,
    #[serde(default = "default_f64::<250>")]
    pub warn_ms: f64,
    #[serde(default = "default_f64::<800>")]
    pub fail_ms: f64,
    #[serde(default = "default_f64::<20>")]
    pub warn_loss_pct: f64,
    #[serde(default = "default_f64::<50>")]
    pub fail_loss_pct: f64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct TlsCertConfig {
    #[serde(default)]
    pub key: String,
    #[serde(default)]
    pub label: String,
    pub group: Option<String>,
    pub path: Option<String>,
    pub connect: Option<String>,
    pub server_name: Option<String>,
    #[serde(default = "default_i64::<14>")]
    pub warn_days: i64,
    #[serde(default = "default_i64::<5>")]
    pub fail_days: i64,
    #[serde(default = "default_u64::<2000>")]
    pub timeout_ms: u64,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExecOutputFormat {
    #[default]
    Exit,
    Json,
    Auto,
}

impl FromStr for ExecOutputFormat {
    type Err = ();

    fn from_str(s: &str) -> std::result::Result<Self, Self::Err> {
        match s.trim().to_ascii_lowercase().as_str() {
            "exit" => Ok(Self::Exit),
            "json" => Ok(Self::Json),
            "auto" => Ok(Self::Auto),
            _ => Err(()),
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct ExecDirDefaults<'a> {
    pub group: Option<&'a str>,
    pub format: ExecOutputFormat,
    pub warn_exit_code: Option<i32>,
    pub timeout_ms: u64,
}

impl Default for ExecDirDefaults<'_> {
    fn default() -> Self {
        Self {
            group: None,
            format: ExecOutputFormat::Auto,
            warn_exit_code: None,
            timeout_ms: EXEC_TIMEOUT_MS,
        }
    }
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
        warn_exit_code: Option<i32>,
        #[serde(default = "default_u64::<EXEC_TIMEOUT_MS>")]
        timeout_ms: u64,
    },
}

impl ExecDirConfig {
    pub fn parts(&self) -> (&str, ExecDirDefaults<'_>) {
        match self {
            Self::Path(path) => (path.as_str(), ExecDirDefaults::default()),
            Self::Detailed {
                path,
                group,
                format,
                warn_exit_code,
                timeout_ms,
            } => (
                path.as_str(),
                ExecDirDefaults {
                    group: group.as_deref(),
                    format: *format,
                    warn_exit_code: *warn_exit_code,
                    timeout_ms: *timeout_ms,
                },
            ),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct ExecCheckConfig {
    #[serde(default)]
    pub key: String,
    #[serde(default)]
    pub label: String,
    pub group: Option<String>,
    #[serde(default)]
    pub command: Vec<String>,
    #[serde(default)]
    pub format: ExecOutputFormat,
    pub warn_exit_code: Option<i32>,
    #[serde(default = "default_u64::<EXEC_TIMEOUT_MS>")]
    pub timeout_ms: u64,
}

pub fn non_empty(value: &str) -> Option<&str> {
    let trimmed = value.trim();

    (!trimmed.is_empty()).then_some(trimmed)
}

fn resolve_secret(
    inline: Option<&str>,
    file: Option<&str>,
    env_var: &str,
) -> Result<Option<String>> {
    if let Some(val) = inline.and_then(non_empty) {
        return Ok(Some(val.to_string()));
    }
    if let Some(path) = file {
        let content = fs::read_to_string(path).with_context(|| format!("failed to read {path}"))?;
        if let Some(val) = non_empty(&content) {
            return Ok(Some(val.to_string()));
        }
    }
    if let Ok(env_val) = std::env::var(env_var)
        && let Some(val) = non_empty(&env_val)
    {
        return Ok(Some(val.to_string()));
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
        for m in cfg.monitors.iter().flatten() {
            ensure!(
                !m.key.trim().is_empty() && !m.name.trim().is_empty() && !m.url.trim().is_empty(),
                "monitors[] requires key, name, and url"
            );
        }

        cfg.node_id = non_empty(&cfg.node_id)
            .map(str::to_string)
            .or_else(|| {
                non_empty(&rustix::system::uname().nodename().to_string_lossy()).map(str::to_string)
            })
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
