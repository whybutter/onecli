//! The mTLS listener: a second, independent [`Entrypoint`] requiring a
//! client certificate on every connection.
//!
//! Configured via `GATEWAY_MTLS_PORT`, `GATEWAY_TLS_CERT`, `GATEWAY_TLS_KEY`
//! and `GATEWAY_CLIENT_CA` (see [`client_ca::MtlsConfig::from_env`], which
//! `main` validates BEFORE `entrypoint::run_all` starts either entrypoint —
//! a bad mTLS config is a boot failure, never a mid-flight teardown of the
//! plaintext listener). Unset `GATEWAY_MTLS_PORT` and this entrypoint is
//! never constructed: the gateway runs exactly as it did before this module
//! existed.
//!
//! Shares everything with the plaintext listener except how the TCP stream
//! is obtained: same shared [`GatewayState`], same `build_router`, same
//! `handle_connection` — the only difference is the TLS handshake in front of
//! it, and the [`client_ca::ClientIdentity`] that handshake yields.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use tokio::net::TcpListener;
use tokio::time::timeout;
use tokio_rustls::TlsAcceptor;
use tracing::{info, warn};

use client_ca::MtlsConfig;
use context::GatewayState;

use crate::{build_router, handle_connection, Entrypoint};

/// Pause before retrying a failed `accept`, mirroring the plaintext
/// listener's own retry delay.
const ACCEPT_RETRY_DELAY: Duration = Duration::from_millis(100);

/// Cap on the TLS handshake itself. The handshake runs inside the
/// per-connection spawned task, never in the accept loop, so a slow or
/// hostile `ClientHello` can only stall its own connection.
const TLS_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);

/// The mTLS listener. Requires and verifies a client certificate
/// (`client_ca::MtlsConfig`'s `WebPkiClientVerifier`, no
/// `allow_unauthenticated`), extracts a [`client_ca::ClientIdentity`] from
/// it, then serves the connection exactly like the plaintext listener
/// otherwise — same router, same `handle_connection`.
pub struct MtlsEntrypoint {
    state: GatewayState,
    config: MtlsConfig,
}

impl MtlsEntrypoint {
    pub fn new(state: GatewayState, config: MtlsConfig) -> Self {
        Self { state, config }
    }
}

#[async_trait::async_trait]
impl Entrypoint for MtlsEntrypoint {
    fn name(&self) -> &'static str {
        "mtls"
    }

    async fn run(self: Box<Self>) -> Result<()> {
        let addr = SocketAddr::new(self.config.bind, self.config.port);
        let listener = TcpListener::bind(addr)
            .await
            .context("binding mTLS TCP listener")?;

        // Report what we actually bound rather than what we asked for — same
        // rationale as the plaintext listener's own bound-address log.
        let bound_addr = listener
            .local_addr()
            .context("reading bound mTLS address")?;
        info!(addr = %bound_addr, "listening for mTLS connections");

        let acceptor = TlsAcceptor::from(Arc::clone(&self.config.server_config));
        let router = build_router(&self.state);
        let mut shutdown_signal = shutdown::subscribe();

        loop {
            let (stream, peer_addr) = tokio::select! {
                accepted = listener.accept() => match accepted {
                    Ok(conn) => conn,
                    Err(e) => {
                        // Same rationale as the plaintext accept loop: a
                        // recoverable accept() error (EMFILE, ECONNABORTED)
                        // must not tear down this listener.
                        warn!(error = %e, "accept failed; retrying");
                        tokio::time::sleep(ACCEPT_RETRY_DELAY).await;
                        continue;
                    }
                },
                _ = shutdown_signal.wait() => break,
            };

            let state = self.state.clone();
            let router = router.clone();
            let acceptor = acceptor.clone();
            let guard = shutdown::task_guard();

            tokio::spawn(async move {
                let _guard = guard;

                let handshake: Result<_, anyhow::Error> = async {
                    let tls_stream =
                        timeout(TLS_HANDSHAKE_TIMEOUT, acceptor.accept(stream)).await??;
                    Ok(tls_stream)
                }
                .await;

                let tls_stream = match handshake {
                    Ok(s) => s,
                    Err(e) => {
                        warn!(peer = %peer_addr, error = ?e, "mTLS handshake rejected");
                        return;
                    }
                };

                // Read the peer's certificate chain before moving the stream
                // into `TokioIo` — `peer_certificates()` is only reachable
                // through the raw rustls connection.
                let client_identity = tls_stream
                    .get_ref()
                    .1
                    .peer_certificates()
                    .and_then(client_ca::identity_from_peer_certs)
                    .map(Arc::new);

                if let Err(e) =
                    handle_connection(tls_stream, peer_addr, state, router, client_identity, true)
                        .await
                {
                    warn!(peer = %peer_addr, error = ?e, "connection error");
                }
            });
        }

        // Closing the port is what stops new work — same rationale as the
        // plaintext listener's own shutdown.
        drop(listener);
        info!("mTLS listener closed — draining connections");
        Ok(())
    }
}
