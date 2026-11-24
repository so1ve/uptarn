use std::time::Duration;

use anyhow::{Context, Result, bail};
use reqwest::Client;
use serde::Serialize;

use crate::config::AgentConfig;
use crate::protocol::{JobReportPayload, NodeReportPayload};

pub struct HubClient {
    http: Client,
    hub_url: String,
    token: String,
    enroll_token: Option<String>,
}

impl HubClient {
    pub fn from_config(cfg: &AgentConfig) -> Result<Self> {
        let http = Client::builder()
            .timeout(Duration::from_secs(12))
            .user_agent(concat!("uptarn-agent/", env!("CARGO_PKG_VERSION")))
            .build()
            .expect("build reqwest client");

        Ok(Self {
            http,
            hub_url: cfg.hub_url.clone(),
            token: cfg.resolved_token()?,
            enroll_token: cfg.resolved_enroll_token()?,
        })
    }

    async fn post_json<T: Serialize>(
        &self,
        path: &str,
        payload: &T,
        include_enroll: bool,
    ) -> Result<()> {
        let url = format!("{}{path}", self.hub_url);
        let mut req = self.http.post(&url).bearer_auth(&self.token).json(payload);
        if include_enroll && let Some(enroll) = &self.enroll_token {
            req = req.header("X-Uptarn-Enroll", enroll);
        }

        let resp = req
            .send()
            .await
            .with_context(|| format!("POST {url} failed"))?;
        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            bail!("hub rejected {path} ({status}): {body}");
        }

        Ok(())
    }

    pub async fn post_report(&self, payload: &NodeReportPayload) -> Result<()> {
        self.post_json("/api/v1/ingest/report", payload, true).await
    }

    pub async fn post_job(&self, payload: &JobReportPayload) -> Result<()> {
        self.post_json("/api/v1/ingest/job", payload, false).await
    }
}
