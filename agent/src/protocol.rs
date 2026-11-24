use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HealthStatus {
    Ok,
    Warn,
    Fail,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SeriesUnit {
    #[serde(rename = "ms")]
    Ms,
    #[serde(rename = "%")]
    Percent,
    #[serde(rename = "bytes")]
    Bytes,
    #[serde(rename = "bps")]
    Bps,
    #[serde(rename = "celsius")]
    Celsius,
    #[serde(rename = "count")]
    Count,
    #[serde(rename = "days")]
    Days,
}

#[derive(Debug, Serialize)]
pub struct SystemSnapshot {
    pub uptime_secs: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cpu_pct: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub load_1m: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mem_used_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mem_total_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub swap_used_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub swap_total_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rx_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tx_bytes: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MountSnapshot {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    pub used_bytes: u64,
    pub total_bytes: u64,
    pub status: HealthStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
}

impl MountSnapshot {
    pub fn failed(path: String, label: Option<String>, summary: impl Into<String>) -> Self {
        Self {
            path,
            label,
            used_bytes: 0,
            total_bytes: 0,
            status: HealthStatus::Fail,
            summary: Some(summary.into()),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CheckSnapshot {
    pub key: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
    pub status: HealthStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl CheckSnapshot {
    pub fn failed(
        key: impl Into<String>,
        label: impl Into<String>,
        group: Option<String>,
        summary: impl Into<String>,
        detail: Option<String>,
    ) -> Self {
        Self {
            key: key.into(),
            label: label.into(),
            group,
            status: HealthStatus::Fail,
            summary: Some(summary.into()),
            detail,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SeriesSnapshot {
    pub key: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
    pub unit: SeriesUnit,
    pub value: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub loss_pct: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<HealthStatus>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InfoSnapshot {
    pub key: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MonitorSpec {
    pub key: String,
    pub name: String,
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub public_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub method: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_status_min: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_status_max: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_body: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interval_secs: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_public: Option<bool>,
}

#[derive(Debug, Serialize)]
pub struct NodeReportPayload {
    pub node_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interval_secs: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub grace_secs: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_public: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub system: Option<SystemSnapshot>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub mounts: Vec<MountSnapshot>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub checks: Vec<CheckSnapshot>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub series: Vec<SeriesSnapshot>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub info: Vec<InfoSnapshot>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub monitors: Option<Vec<MonitorSpec>>,
}

#[derive(Debug, Serialize)]
pub struct JobReportPayload {
    pub job_key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub node_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    pub interval_secs: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub grace_secs: Option<u64>,
    pub status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
pub struct StructuredExecOutput {
    pub status: Option<HealthStatus>,
    pub summary: Option<String>,
    pub detail: Option<String>,
    #[serde(default)]
    pub mounts: Vec<MountSnapshot>,
    #[serde(default)]
    pub checks: Vec<CheckSnapshot>,
    #[serde(default)]
    pub series: Vec<SeriesSnapshot>,
    #[serde(default)]
    pub info: Vec<InfoSnapshot>,
}
