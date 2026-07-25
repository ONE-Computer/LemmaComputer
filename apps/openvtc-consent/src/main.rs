use std::net::SocketAddr;

use base64::{Engine as _, engine::general_purpose::STANDARD};
use onecomputer_openvtc_consent::{AppState, router};
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env())
        .init();
    let token = required("OPENVTC_CONSENT_TOKEN");
    let seed = STANDARD
        .decode(required("OPENVTC_EXECUTOR_SEED_B64"))
        .expect("OPENVTC_EXECUTOR_SEED_B64 must be standard base64");
    let seed: [u8; 32] = seed
        .try_into()
        .expect("OPENVTC_EXECUTOR_SEED_B64 must decode to exactly 32 bytes");
    let state = AppState::from_seed(token, seed).expect("invalid OpenVTC configuration");
    let address: SocketAddr = std::env::var("OPENVTC_CONSENT_LISTEN")
        .unwrap_or_else(|_| "0.0.0.0:8788".into())
        .parse()
        .expect("OPENVTC_CONSENT_LISTEN must be a socket address");
    let listener = tokio::net::TcpListener::bind(address)
        .await
        .expect("bind OpenVTC consent service");
    tracing::info!(%address, "OpenVTC consent service ready");
    axum::serve(listener, router(state))
        .with_graceful_shutdown(shutdown())
        .await
        .expect("serve OpenVTC consent service");
}

fn required(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("{name} is required"))
}

async fn shutdown() {
    #[cfg(unix)]
    {
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                .expect("install SIGTERM handler");
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = terminate.recv() => {}
        }
    }
    #[cfg(not(unix))]
    let _ = tokio::signal::ctrl_c().await;
}
