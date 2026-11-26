use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HealthStatus {
    Ok,
    Warn,
    Fail,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum JobRunStatus {
    Pending,
    Running,
    Ok,
    Fail,
    Overdue,
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

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MonitorProbeType {
    #[default]
    Http,
    Tcp,
    Exec,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MonitorProbeFrom {
    Hub,
    Agent,
}

#[derive(Debug, Serialize)]
pub struct LiveIngestFrame {
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
    pub rx_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tx_bytes: Option<u64>,
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
pub struct JobSnapshot {
    pub key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub schedule: Option<String>,
    pub status: JobRunStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_run_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_run_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MonitorProbeReport {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latency_ms: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub http_status: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "from", rename_all = "lowercase")]
pub enum MonitorSpec {
    Hub {
        key: String,
        name: String,
        url: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        public_url: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        method: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        expected_status_min: Option<u16>,
        #[serde(skip_serializing_if = "Option::is_none")]
        expected_status_max: Option<u16>,
        #[serde(skip_serializing_if = "Option::is_none")]
        expected_body: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        timeout_ms: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        interval_secs: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        enabled: Option<bool>,
        #[serde(skip_serializing_if = "Option::is_none")]
        is_public: Option<bool>,
    },
    Agent {
        key: String,
        name: String,
        #[serde(rename = "type")]
        probe_type: MonitorProbeType,
        #[serde(skip_serializing_if = "Option::is_none")]
        target: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        public_url: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        interval_secs: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        grace_secs: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        enabled: Option<bool>,
        #[serde(skip_serializing_if = "Option::is_none")]
        is_public: Option<bool>,
        #[serde(skip_serializing_if = "Option::is_none")]
        result: Option<MonitorProbeReport>,
    },
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
    pub jobs: Vec<JobSnapshot>,
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
    #[serde(default)]
    pub jobs: Vec<JobSnapshot>,
}

impl StructuredExecOutput {
    pub const fn is_empty(&self) -> bool {
        self.mounts.is_empty()
            && self.checks.is_empty()
            && self.series.is_empty()
            && self.info.is_empty()
            && self.jobs.is_empty()
    }

    pub fn apply_default_group(&mut self, group: &str) {
        for c in &mut self.checks {
            c.group.get_or_insert_with(|| group.to_string());
        }
        for s in &mut self.series {
            s.group.get_or_insert_with(|| group.to_string());
        }
        for i in &mut self.info {
            i.group.get_or_insert_with(|| group.to_string());
        }
    }
}
