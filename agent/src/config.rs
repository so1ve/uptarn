use std::fs;
use std::path::Path;
use std::str::FromStr;

use anyhow::{Context, Result, bail, ensure};
use serde::Deserialize;

use crate::protocol::{InfoSnapshot, MonitorProbeFrom, MonitorProbeType};

pub const EXEC_TIMEOUT_MS: u64 = 5000;
pub const PROBE_TIMEOUT_MS: u64 = 2000;

const fn default_u64<const V: u64>() -> u64 {
    V
}
const fn default_f64<const V: u32>() -> f64 {
    V as f64
}
const fn default_auto_format() -> ExecOutputFormat {
    ExecOutputFormat::Auto
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
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
    #[serde(default = "default_u64::<3>")]
    pub live_interval_secs: u64,
    pub grace_secs: Option<u64>,
    pub is_public: Option<bool>,
    #[serde(default)]
    pub system: SystemCollectConfig,
    #[serde(default)]
    pub mounts: Vec<MountConfig>,
    #[serde(default)]
    pub checks: Vec<CheckConfig>,
    #[serde(default)]
    pub check_dirs: Vec<CheckDirConfig>,
    #[serde(default)]
    pub info: Vec<InfoSnapshot>,
    pub monitors: Option<Vec<MonitorConfig>>,
}

#[expect(
    clippy::struct_excessive_bools,
    reason = "Independent per-metric TOML switches in [system]"
)]
#[derive(Debug, Clone, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct SystemCollectConfig {
    pub enabled: bool,
    pub cpu: bool,
    pub memory: bool,
    pub load: bool,
    pub network: bool,
    pub temperature: bool,
    pub os_info: bool,
    pub interfaces: Vec<String>,
    pub cpu_warn_pct: Option<f64>,
    pub cpu_fail_pct: Option<f64>,
    pub mem_warn_pct: Option<f64>,
    pub mem_fail_pct: Option<f64>,
    pub load_warn: Option<f64>,
    pub load_fail: Option<f64>,
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
            cpu_warn_pct: None,
            cpu_fail_pct: None,
            mem_warn_pct: None,
            mem_fail_pct: None,
            load_warn: None,
            load_fail: None,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
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

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CheckKind {
    #[default]
    Exec,
    Tls,
    Tcp,
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

#[derive(Debug, Clone)]
pub struct ExecCheckConfig {
    pub key: String,
    pub label: String,
    pub group: Option<String>,
    pub command: Vec<String>,
    pub format: ExecOutputFormat,
    pub warn_exit_code: Option<i32>,
    pub timeout_ms: u64,
}

#[derive(Debug, Clone)]
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

#[derive(Debug, Clone)]
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

#[derive(Debug, Clone, Deserialize)]
#[serde(try_from = "RawCheckConfig")]
pub enum CheckConfig {
    Exec(ExecCheckConfig),
    Tls(TlsCertConfig),
    Tcp(TcpProbeConfig),
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RawCheckConfig {
    #[serde(rename = "type", default)]
    pub kind: CheckKind,
    pub key: Option<String>,
    pub label: Option<String>,
    pub group: Option<String>,
    pub timeout_ms: Option<u64>,
    // exec fields
    #[serde(default)]
    pub command: Vec<String>,
    pub format: Option<ExecOutputFormat>,
    pub warn_exit_code: Option<i32>,
    // tls fields
    pub path: Option<String>,
    pub connect: Option<String>,
    pub server_name: Option<String>,
    pub warn_days: Option<i64>,
    pub fail_days: Option<i64>,
    // tcp fields
    pub target: Option<String>,
    pub count: Option<u32>,
    pub warn_ms: Option<f64>,
    pub fail_ms: Option<f64>,
    pub warn_loss_pct: Option<f64>,
    pub fail_loss_pct: Option<f64>,
}

impl RawCheckConfig {
    pub fn into_check(
        self,
        key: String,
        label: String,
        group: Option<String>,
        defaults: CheckDirDefaults<'_>,
    ) -> std::result::Result<CheckConfig, String> {
        match self.kind {
            CheckKind::Exec => {
                if self.command.is_empty()
                    || self.command.first().and_then(|s| non_empty(s)).is_none()
                {
                    return Err("exec check requires non-empty command".to_string());
                }
                if self.target.is_some()
                    || self.path.is_some()
                    || self.connect.is_some()
                    || self.server_name.is_some()
                    || self.count.is_some()
                    || self.warn_days.is_some()
                    || self.fail_days.is_some()
                    || self.warn_ms.is_some()
                    || self.fail_ms.is_some()
                    || self.warn_loss_pct.is_some()
                    || self.fail_loss_pct.is_some()
                {
                    return Err("exec check cannot set tls or tcp fields".to_string());
                }

                Ok(CheckConfig::Exec(ExecCheckConfig {
                    key,
                    label,
                    group,
                    command: self.command,
                    format: self.format.unwrap_or(defaults.format),
                    warn_exit_code: self.warn_exit_code.or(defaults.warn_exit_code),
                    timeout_ms: self.timeout_ms.unwrap_or(defaults.timeout_ms),
                }))
            }
            CheckKind::Tls => {
                if self.path.as_deref().and_then(non_empty).is_none()
                    && self.connect.as_deref().and_then(non_empty).is_none()
                {
                    return Err("tls check requires either path or connect".to_string());
                }
                if !self.command.is_empty()
                    || self.format.is_some()
                    || self.warn_exit_code.is_some()
                    || self.target.is_some()
                    || self.count.is_some()
                    || self.warn_ms.is_some()
                    || self.fail_ms.is_some()
                    || self.warn_loss_pct.is_some()
                    || self.fail_loss_pct.is_some()
                {
                    return Err("tls check cannot set exec or tcp fields".to_string());
                }

                Ok(CheckConfig::Tls(TlsCertConfig {
                    key,
                    label,
                    group,
                    path: self.path.and_then(|s| non_empty(&s).map(str::to_string)),
                    connect: self.connect.and_then(|s| non_empty(&s).map(str::to_string)),
                    server_name: self
                        .server_name
                        .and_then(|s| non_empty(&s).map(str::to_string)),
                    warn_days: self.warn_days.unwrap_or(14),
                    fail_days: self.fail_days.unwrap_or(5),
                    timeout_ms: self.timeout_ms.unwrap_or(PROBE_TIMEOUT_MS),
                }))
            }
            CheckKind::Tcp => {
                let Some(target) = self.target.and_then(|s| non_empty(&s).map(str::to_string))
                else {
                    return Err("tcp check requires target".to_string());
                };
                if !self.command.is_empty()
                    || self.format.is_some()
                    || self.warn_exit_code.is_some()
                    || self.path.is_some()
                    || self.connect.is_some()
                    || self.server_name.is_some()
                    || self.warn_days.is_some()
                    || self.fail_days.is_some()
                {
                    return Err("tcp check cannot set exec or tls fields".to_string());
                }

                Ok(CheckConfig::Tcp(TcpProbeConfig {
                    key,
                    label,
                    group,
                    target,
                    count: self.count.unwrap_or(4),
                    timeout_ms: self.timeout_ms.unwrap_or(PROBE_TIMEOUT_MS),
                    warn_ms: self.warn_ms.unwrap_or(250.0),
                    fail_ms: self.fail_ms.unwrap_or(800.0),
                    warn_loss_pct: self.warn_loss_pct.unwrap_or(20.0),
                    fail_loss_pct: self.fail_loss_pct.unwrap_or(50.0),
                }))
            }
        }
    }
}

impl TryFrom<RawCheckConfig> for CheckConfig {
    type Error = String;

    fn try_from(raw: RawCheckConfig) -> std::result::Result<Self, Self::Error> {
        let Some(key) = raw.key.as_deref().and_then(non_empty).map(str::to_string) else {
            return Err("checks[] requires key".to_string());
        };
        let label = raw
            .label
            .as_deref()
            .and_then(non_empty)
            .unwrap_or(&key)
            .to_string();
        let group = raw.group.as_deref().and_then(non_empty).map(str::to_string);

        raw.into_check(
            key,
            label,
            group,
            CheckDirDefaults {
                group: None,
                format: ExecOutputFormat::Exit,
                warn_exit_code: None,
                timeout_ms: EXEC_TIMEOUT_MS,
            },
        )
    }
}

#[derive(Debug, Clone, Copy)]
pub struct CheckDirDefaults<'a> {
    pub group: Option<&'a str>,
    pub format: ExecOutputFormat,
    pub warn_exit_code: Option<i32>,
    pub timeout_ms: u64,
}

impl Default for CheckDirDefaults<'_> {
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
pub enum CheckDirConfig {
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

impl CheckDirConfig {
    pub fn parts(&self) -> (&str, CheckDirDefaults<'_>) {
        match self {
            Self::Path(path) => (path.as_str(), CheckDirDefaults::default()),
            Self::Detailed {
                path,
                group,
                format,
                warn_exit_code,
                timeout_ms,
            } => (
                path.as_str(),
                CheckDirDefaults {
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
#[serde(deny_unknown_fields)]
pub struct MonitorConfig {
    #[serde(default)]
    pub key: String,
    #[serde(default)]
    pub name: String,
    #[serde(rename = "type", default)]
    pub probe_type: MonitorProbeType,
    #[serde(rename = "from")]
    pub probe_from: Option<MonitorProbeFrom>,
    pub url: Option<String>,
    pub target: Option<String>,
    #[serde(default)]
    pub command: Vec<String>,
    pub public_url: Option<String>,
    pub method: Option<String>,
    pub expected_status_min: Option<u16>,
    pub expected_status_max: Option<u16>,
    pub expected_body: Option<String>,
    pub timeout_ms: Option<u64>,
    pub interval_secs: Option<u64>,
    pub grace_secs: Option<u64>,
    pub enabled: Option<bool>,
    pub is_public: Option<bool>,
}

impl MonitorConfig {
    pub const fn resolved_from(&self) -> MonitorProbeFrom {
        match self.probe_from {
            Some(from) => from,
            None => match self.probe_type {
                MonitorProbeType::Http => MonitorProbeFrom::Hub,
                MonitorProbeType::Tcp | MonitorProbeType::Exec => MonitorProbeFrom::Agent,
            },
        }
    }

    pub const fn default_timeout_ms(&self) -> u64 {
        match self.probe_type {
            MonitorProbeType::Http => 8000,
            MonitorProbeType::Tcp => 3000,
            MonitorProbeType::Exec => 5000,
        }
    }
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

fn validate_thresholds(
    name: &str,
    warn: Option<f64>,
    fail: Option<f64>,
    max: Option<f64>,
) -> Result<()> {
    for (kind, value) in [("warn", warn), ("fail", fail)] {
        if let Some(v) = value {
            ensure!(
                v.is_finite() && v > 0.0 && max.is_none_or(|limit| v <= limit),
                "{name}_{kind} must be a positive finite number{}",
                max.map(|limit| format!(" <= {limit}")).unwrap_or_default()
            );
        }
    }
    if let (Some(w), Some(f)) = (warn, fail) {
        ensure!(w <= f, "{name}_warn must be <= {name}_fail");
    }

    Ok(())
}

impl AgentConfig {
    pub fn load(path: &Path) -> Result<Self> {
        let raw = fs::read_to_string(path)
            .with_context(|| format!("failed to read config {}", path.display()))?;
        let mut cfg: Self = toml::from_str(&raw)
            .with_context(|| format!("failed to parse TOML config {}", path.display()))?;
        cfg.hub_url = cfg.hub_url.trim().trim_end_matches('/').to_string();
        ensure!(!cfg.hub_url.is_empty(), "hub_url cannot be empty");
        validate_thresholds(
            "system.cpu",
            cfg.system.cpu_warn_pct,
            cfg.system.cpu_fail_pct,
            Some(100.0),
        )?;
        validate_thresholds(
            "system.mem",
            cfg.system.mem_warn_pct,
            cfg.system.mem_fail_pct,
            Some(100.0),
        )?;
        validate_thresholds(
            "system.load",
            cfg.system.load_warn,
            cfg.system.load_fail,
            None,
        )?;
        for m in &cfg.mounts {
            ensure!(!m.path.trim().is_empty(), "mounts[].path cannot be empty");
        }
        for m in cfg.monitors.iter().flatten() {
            ensure!(
                !m.key.trim().is_empty() && !m.name.trim().is_empty(),
                "monitors[] requires key and name"
            );
            let from = m.resolved_from();
            if from == MonitorProbeFrom::Hub {
                ensure!(
                    m.probe_type == MonitorProbeType::Http,
                    "monitors[{}]: hub-probed monitors only support type = \"http\"",
                    m.key
                );
            }
            match m.probe_type {
                MonitorProbeType::Http => {
                    let url = m.url.as_deref().and_then(non_empty).with_context(|| {
                        format!("monitors[{}]: http monitor requires url", m.key)
                    })?;
                    ensure!(
                        url.starts_with("http://") || url.starts_with("https://"),
                        "monitors[{}]: url must start with http:// or https://",
                        m.key
                    );
                    ensure!(
                        m.command.is_empty() && m.target.is_none(),
                        "monitors[{}]: http monitor cannot set target or command",
                        m.key
                    );
                    if let Some(method) = m.method.as_deref().and_then(non_empty) {
                        ensure!(
                            matches!(
                                method.to_ascii_uppercase().as_str(),
                                "GET" | "HEAD" | "POST"
                            ),
                            "monitors[{}]: method must be GET, HEAD, or POST",
                            m.key
                        );
                    }
                }
                MonitorProbeType::Tcp => {
                    ensure!(
                        m.target.as_deref().and_then(non_empty).is_some(),
                        "monitors[{}]: tcp monitor requires target",
                        m.key
                    );
                    ensure!(
                        m.url.is_none() && m.command.is_empty(),
                        "monitors[{}]: tcp monitor cannot set url or command",
                        m.key
                    );
                }
                MonitorProbeType::Exec => {
                    ensure!(
                        m.command.first().and_then(|s| non_empty(s)).is_some(),
                        "monitors[{}]: exec monitor requires non-empty command",
                        m.key
                    );
                    ensure!(
                        m.url.is_none(),
                        "monitors[{}]: exec monitor cannot set url",
                        m.key
                    );
                }
            }
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

#[cfg(test)]
mod tests {
    use super::validate_thresholds;

    #[test]
    fn validates_system_threshold_bounds_and_order() {
        assert!(validate_thresholds("system.cpu", Some(80.0), Some(95.0), Some(100.0)).is_ok());
        assert!(validate_thresholds("system.cpu", Some(95.0), Some(80.0), Some(100.0)).is_err());
        assert!(validate_thresholds("system.cpu", None, Some(105.0), Some(100.0)).is_err());
        assert!(validate_thresholds("system.load", Some(0.0), None, None).is_err());
        assert!(validate_thresholds("system.load", Some(2.5), Some(6.0), None).is_ok());
    }
}
