//! CLI arguments for `onecli-gateway relay`.

use std::net::SocketAddr;
use std::path::PathBuf;

use clap::Args;

/// CLI arguments for `onecli-gateway relay`. Every field falls back to an
/// environment variable so the relay can run unattended in a container
/// without a generated command line.
#[derive(Args, Debug, Clone)]
pub struct RelayArgs {
    /// Local address the relay listens on for plain HTTP-proxy connections
    /// from an agent.
    #[arg(long, env = "RELAY_BIND", default_value = "127.0.0.1:10255")]
    pub(crate) bind: SocketAddr,

    /// `host:port` of the remote gateway's mTLS listener (the port
    /// configured via `GATEWAY_MTLS_PORT` on that gateway).
    #[arg(long, env = "RELAY_GATEWAY_ADDR")]
    pub(crate) gateway_addr: String,

    /// Name used for TLS SNI and server-certificate verification against
    /// the remote gateway. Defaults to the host part of `--gateway-addr`.
    #[arg(long, env = "RELAY_GATEWAY_SERVER_NAME")]
    pub(crate) gateway_server_name: Option<String>,

    /// Trust anchor for the remote gateway's SERVER certificate — inline PEM
    /// or a filesystem path (resolved via [`client_ca::pem_from_value`]).
    /// REQUIRED: the relay always verifies the gateway's server certificate
    /// and never falls back to an accept-any verifier.
    #[arg(long, env = "RELAY_GATEWAY_SERVER_CA")]
    pub(crate) gateway_server_ca: String,

    /// Base URL of the OneCLI API (Node), used to enroll/renew the relay's
    /// client certificate via `POST /v1/gateway/client-cert`.
    #[arg(long, env = "RELAY_API_URL")]
    pub(crate) api_url: String,

    /// Workspace-scoped `oc_` API key, sent as `Authorization: Bearer` on the
    /// enrollment call.
    #[arg(long, env = "RELAY_API_KEY")]
    pub(crate) api_key: String,

    /// Optional human-readable label for the enrolled `ClientHost` row.
    #[arg(long, env = "RELAY_LABEL")]
    pub(crate) label: Option<String>,

    /// Optional directory to persist the relay's private key, current
    /// certificate, and host id (mode 0600) across restarts. Without it, the
    /// relay generates a fresh keypair and enrolls as a brand-new host every
    /// time it starts.
    #[arg(long, env = "RELAY_STATE_DIR")]
    pub(crate) state_dir: Option<PathBuf>,
}
