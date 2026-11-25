use std::sync::{Arc, LazyLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, anyhow};
use rustls::DigitallySignedStruct;
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls_pki_types::pem::PemObject;
use rustls_pki_types::{CertificateDer, ServerName, UnixTime};
use tokio::net::TcpStream;
use tokio::time::timeout;
use tokio_rustls::TlsConnector;

use super::x509;
use crate::config::TlsCertConfig;
use crate::protocol::{HealthStatus, SeriesSnapshot, SeriesUnit};

#[derive(Debug)]
struct InspectOnlyCertVerifier;

impl ServerCertVerifier for InspectOnlyCertVerifier {
    fn verify_server_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> std::result::Result<ServerCertVerified, rustls::Error> {
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &DigitallySignedStruct,
    ) -> std::result::Result<HandshakeSignatureValid, rustls::Error> {
        Ok(HandshakeSignatureValid::assertion())
    }

    fn verify_tls13_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &DigitallySignedStruct,
    ) -> std::result::Result<HandshakeSignatureValid, rustls::Error> {
        Ok(HandshakeSignatureValid::assertion())
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        rustls::crypto::ring::default_provider()
            .signature_verification_algorithms
            .supported_schemes()
    }
}

static INSPECT_TLS_CONNECTOR: LazyLock<TlsConnector> = LazyLock::new(|| {
    let cfg = rustls::ClientConfig::builder()
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(InspectOnlyCertVerifier))
        .with_no_client_auth();

    TlsConnector::from(Arc::new(cfg))
});

fn cert_days_remaining(der: &[u8]) -> Result<f64> {
    let not_after = x509::parse_not_after_unix(der)?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;
    let remaining_days = (not_after - now) as f64 / 86_400.0;

    Ok((remaining_days * 10.0).round() / 10.0)
}

async fn read_tls_days(cfg: &TlsCertConfig) -> Result<f64> {
    if let Some(file_path) = &cfg.path {
        let first_cert = CertificateDer::from_pem_file(file_path)
            .with_context(|| format!("failed to read PEM certificate {file_path}"))?;

        return cert_days_remaining(first_cert.as_ref());
    }

    let connect_addr = cfg
        .connect
        .as_deref()
        .context("tls check requires either path or connect")?;
    let sni_host = cfg
        .server_name
        .as_deref()
        .or_else(|| {
            connect_addr
                .strip_prefix('[')
                .and_then(|rest| rest.split(']').next())
                .or_else(|| connect_addr.rsplit_once(':').map(|(host, _)| host))
        })
        .context("missing server_name for TLS check")?;

    let server_name = ServerName::try_from(sni_host.to_string())
        .map_err(|_| anyhow!("invalid TLS server_name '{sni_host}'"))?;

    let stream = timeout(
        Duration::from_millis(cfg.timeout_ms),
        TcpStream::connect(connect_addr),
    )
    .await
    .context("TCP connect timed out")??;

    let tls_stream = timeout(
        Duration::from_millis(cfg.timeout_ms),
        INSPECT_TLS_CONNECTOR.connect(server_name, stream),
    )
    .await
    .context("TLS handshake timed out")??;

    let (_, conn) = tls_stream.into_inner();
    let leaf = conn
        .peer_certificates()
        .and_then(|certs| certs.first())
        .context("peer sent no TLS certificate")?;

    cert_days_remaining(leaf.as_ref())
}

pub async fn collect_tls_cert(cfg: &TlsCertConfig) -> SeriesSnapshot {
    let (value, status, summary) = match read_tls_days(cfg).await {
        Ok(days) => {
            let whole = days.floor() as i64;
            let status = if whole <= cfg.fail_days {
                HealthStatus::Fail
            } else if whole <= cfg.warn_days {
                HealthStatus::Warn
            } else {
                HealthStatus::Ok
            };

            (days, status, format!("{days:.0} days left"))
        }
        Err(err) => (0.0, HealthStatus::Fail, format!("TLS check error: {err}")),
    };

    SeriesSnapshot {
        key: cfg.key.clone(),
        label: cfg.label.clone(),
        group: cfg.group.clone(),
        unit: SeriesUnit::Days,
        value,
        loss_pct: None,
        status: Some(status),
        summary: Some(summary),
    }
}
