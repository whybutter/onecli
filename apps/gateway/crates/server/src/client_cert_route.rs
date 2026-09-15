//! `POST /v1/internal/client-cert/issue` — the gateway-internal endpoint
//! Node's `mintClientCert` (`packages/api/src/lib/gateway-client-cert.ts`)
//! calls to mint a client certificate from a CSR on an agent's behalf.
//!
//! This is a NEW inbound-direction check, not a reuse of
//! `vault::onepassword_api`'s `internal_secret()` — that one is the
//! OUTBOUND direction (the gateway presenting `X-Gateway-Secret` to Node's
//! `/v1/internal/onepassword/*`). Same env var (`GATEWAY_INTERNAL_SECRET`),
//! opposite direction, a completely separate `OnceLock` — do not try to
//! merge the two.

use std::sync::OnceLock;

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use tracing::warn;

use client_ca::authority::{self, SignCsrError};
use context::GatewayState;

/// Hard cap on the `POST /v1/internal/client-cert/issue` request body — a
/// CSR (plus `host_id`/`spiffe_uri`/`lifetime_secs`) is a few KB at most even
/// generously padded, nowhere near axum's much larger generic default body
/// limit. Checked explicitly in `issue_client_cert` before the body is
/// parsed, matching the 16KB cap `validations/client-cert.ts` enforces on
/// the Node side.
const MAX_CLIENT_CERT_REQUEST_BODY_BYTES: usize = 16 * 1024;

/// Shared secret the internal gateway<->Node endpoints authenticate with,
/// presented as the `X-Gateway-Secret` header. Read once, cached in a
/// process-wide `OnceLock` distinct from `vault::onepassword_api`'s own
/// (outbound-direction) `OnceLock` of the same env var — see the module doc
/// comment.
fn internal_secret() -> &'static str {
    static SECRET: OnceLock<String> = OnceLock::new();
    SECRET.get_or_init(|| std::env::var("GATEWAY_INTERNAL_SECRET").unwrap_or_default())
}

/// Constant-time byte comparison (no data-dependent early exit once lengths
/// match — only the accumulated OR of differences is inspected at the end).
/// `ring::constant_time::verify_slices_are_equal` is deprecated upstream
/// ("internal function, no side-channel promises"), so this is hand-rolled
/// rather than built on it — the same approach Node's `timingSafeEqual`
/// implements, mirrored here for the Rust side of this shared-secret check.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff: u8 = 0;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// Comparison against an explicit expected value, fail-closed when that
/// value is empty. Mirrors `packages/api/src/middleware/internal-auth.ts`:
/// an empty configured secret must reject EVERY caller (including one
/// presenting an empty header) rather than "matching" on emptiness — an
/// unconfigured secret is a misconfiguration, never an open door.
///
/// Split from `verify_internal_secret` (which reads the process-wide
/// `OnceLock`-cached env var) purely so this fail-closed logic is directly
/// unit-testable: `internal_secret()`'s cached value can only ever be set
/// once per test binary, which makes it unsuitable for exercising multiple
/// expected-secret scenarios from within the same process.
fn verify_secret(provided: &str, expected: &str) -> bool {
    !expected.is_empty() && constant_time_eq(provided.as_bytes(), expected.as_bytes())
}

/// Comparison against the configured secret — see `verify_secret` for the
/// fail-closed rule this enforces.
fn verify_internal_secret(provided: &str) -> bool {
    verify_secret(provided, internal_secret())
}

/// Body of `POST /v1/internal/client-cert/issue`. `lifetime_secs` is
/// optional — [`authority::clamp_lifetime`] supplies the default (24h) and
/// ceiling (7d).
#[derive(serde::Deserialize)]
struct IssueClientCertRequest {
    host_id: String,
    spiffe_uri: String,
    csr_pem: String,
    #[serde(default)]
    lifetime_secs: Option<u64>,
}

#[derive(serde::Serialize)]
struct IssueClientCertResponse {
    cert_pem: String,
    ca_pem: String,
    serial_hex: String,
    not_after_unix: i64,
}

/// `POST /v1/internal/client-cert/issue`: mints a client certificate for
/// `host_id`/`spiffe_uri` from a CSR Node forwards on an agent's behalf.
///
/// Guarded by a shared secret (`X-Gateway-Secret`), NOT the session/API-key
/// auth every workspace-facing route uses — Node is the only caller, and it
/// has already authenticated the human/agent requesting enrollment before it
/// ever calls here. The secret is checked BEFORE the body is parsed (raw
/// `Bytes`, not an `axum::Json` extractor) so an unauthorized caller always
/// gets 401 regardless of what it sent as a body — never a 400 that leaks
/// "the body shape was wrong" to someone who doesn't hold the shared secret.
///
/// `sign_csr` re-parses and re-verifies the CSR itself — Node's own
/// well-formedness check (if any) is never trusted as the security boundary;
/// this endpoint is that boundary.
pub(crate) async fn issue_client_cert(
    State(state): State<GatewayState>,
    headers: hyper::HeaderMap,
    body: axum::body::Bytes,
) -> impl IntoResponse {
    let provided = headers
        .get("x-gateway-secret")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if !verify_internal_secret(provided) {
        return (
            StatusCode::UNAUTHORIZED,
            axum::Json(serde_json::json!({ "error": "unauthorized" })),
        )
            .into_response();
    }

    // Explicit, tight cap ahead of axum's own (much larger) default body
    // limit: a CSR — even a generously padded one, e.g. an RSA-4096 key with
    // extra attributes — is a few KB at most. Reject anything wildly outside
    // that BEFORE spending effort on it, rather than relying solely on
    // axum's generic default limit (which exists for arbitrary request
    // bodies, not this specifically small shape).
    if body.len() > MAX_CLIENT_CERT_REQUEST_BODY_BYTES {
        return (
            StatusCode::PAYLOAD_TOO_LARGE,
            axum::Json(serde_json::json!({ "error": "request body too large" })),
        )
            .into_response();
    }

    let Some(client_ca) = state.client_ca.as_ref() else {
        warn!("client-cert mint requested but no client-CA minting authority is configured");
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            axum::Json(
                serde_json::json!({ "error": "client certificate minting is not available" }),
            ),
        )
            .into_response();
    };

    let req: IssueClientCertRequest = match serde_json::from_slice(&body) {
        Ok(r) => r,
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                axum::Json(serde_json::json!({ "error": format!("invalid request body: {e}") })),
            )
                .into_response();
        }
    };

    let lifetime = authority::clamp_lifetime(req.lifetime_secs);

    match client_ca.sign_csr(&req.host_id, &req.spiffe_uri, &req.csr_pem, lifetime) {
        Ok(issued) => (
            StatusCode::OK,
            axum::Json(IssueClientCertResponse {
                cert_pem: issued.cert_pem,
                ca_pem: client_ca.ca_cert_pem(),
                serial_hex: issued.serial_hex,
                not_after_unix: issued.not_after_unix,
            }),
        )
            .into_response(),
        Err(SignCsrError::BadCsr(msg)) => (
            StatusCode::BAD_REQUEST,
            axum::Json(serde_json::json!({ "error": format!("invalid CSR: {msg}") })),
        )
            .into_response(),
        Err(SignCsrError::Sign(err)) => {
            warn!(error = ?err, "client-cert signing failed");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                axum::Json(serde_json::json!({ "error": "signing failed" })),
            )
                .into_response()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    use std::sync::Arc;

    use base64::Engine;
    use ca::CertificateAuthority;
    use client_ca::authority::ClientCa;
    use tokio_rustls::TlsConnector;
    use vault::bitwarden::{BitwardenConfig, BitwardenVaultProvider};
    use vault::onepassword::OnePasswordVaultProvider;
    use vault::{VaultProvider, VaultService};

    /// `ClientConfig::builder()`/CSR signing panics when no process-default
    /// crypto provider is installed, and both `ring` and `aws-lc-rs` are
    /// compiled in, so rustls cannot pick one on its own. `main` installs it
    /// at startup; tests must too (mirrors `crate::tests::ensure_crypto_provider`).
    fn ensure_crypto_provider() {
        static INIT_CRYPTO: std::sync::Once = std::sync::Once::new();
        INIT_CRYPTO.call_once(|| {
            let _ = rustls::crypto::ring::default_provider().install_default();
        });
    }

    /// Build a `GatewayState` usable for handler-level tests: a lazy Postgres
    /// pool (never actually connected to — nothing under test issues a real
    /// query against it), in-memory cache/approval stores, and a fresh MITM
    /// CA in a tempdir. `client_ca` starts `None`; tests that need minting
    /// set it explicitly (mirrors `state.client_ca`'s "operator set
    /// GATEWAY_CLIENT_CA, no matching key" `None` case).
    async fn test_gateway_state() -> GatewayState {
        ensure_crypto_provider();
        let pool = sqlx::postgres::PgPoolOptions::new()
            .connect_lazy("postgres://test:test@127.0.0.1/test")
            .expect("lazy pool");
        let crypto = Arc::new(
            crypto::CryptoService::from_base64_key(
                &base64::engine::general_purpose::STANDARD.encode([0u8; 32]),
            )
            .expect("crypto"),
        );
        let onepassword = Arc::new(OnePasswordVaultProvider::new(
            pool.clone(),
            Arc::clone(&crypto),
        ));
        let policy_engine = Arc::new(context::PolicyEngine {
            pool: pool.clone(),
            crypto: Arc::clone(&crypto),
            onepassword: Arc::clone(&onepassword),
        });
        let bitwarden = BitwardenVaultProvider::new(
            BitwardenConfig {
                proxy_url: "wss://example.invalid".to_string(),
            },
            pool.clone(),
            Arc::clone(&crypto),
        );
        let providers: Vec<Arc<dyn VaultProvider>> = vec![Arc::new(bitwarden), onepassword];
        let vault_service = Arc::new(VaultService::new(providers, pool.clone()));
        let cache = cache::in_memory();
        let approval_store = approval::in_memory();

        let tmp = tempfile::tempdir().expect("tempdir");
        let ca = CertificateAuthority::load_or_generate(tmp.path())
            .await
            .expect("test ca");

        GatewayState {
            ca: Arc::new(ca),
            http_client: reqwest::Client::new(),
            http_client_no_verify: reqwest::Client::new(),
            skip_verify_hosts: Arc::new(Vec::new()),
            ws_connector: TlsConnector::from(std::sync::Arc::new(
                rustls::ClientConfig::builder()
                    .with_root_certificates(rustls::RootCertStore::empty())
                    .with_no_client_auth(),
            )),
            ws_connector_no_verify: TlsConnector::from(std::sync::Arc::new(
                rustls::ClientConfig::builder()
                    .with_root_certificates(rustls::RootCertStore::empty())
                    .with_no_client_auth(),
            )),
            policy_engine,
            cache,
            vault_service,
            approval_store,
            client_ca: None,
        }
    }

    /// A `ClientCa` authority backed by a fresh tempdir, for tests that need
    /// `state.client_ca` to be `Some`.
    async fn test_client_ca() -> ClientCa {
        let tmp = tempfile::tempdir().expect("tempdir");
        ClientCa::load_or_generate(Path::new(tmp.path()))
            .await
            .expect("client ca authority")
    }

    /// Build a PEM-encoded CSR for a fresh keypair, requesting `cn` as its
    /// own (attacker-controlled) subject — `sign_csr` must discard this
    /// entirely and use only the request's server-supplied `host_id`/
    /// `spiffe_uri` (see the SECURITY note on `ClientCa::sign_csr`). Kept
    /// local to this crate's test module rather than reused from
    /// `client-ca`'s own (private, same-crate-only) test helper.
    fn generate_csr_pem(cn: &str) -> String {
        use rcgen::{CertificateParams, DistinguishedName, DnType, KeyPair};

        let key = KeyPair::generate().expect("keypair");
        let mut params = CertificateParams::default();
        params.distinguished_name = DistinguishedName::new();
        params.distinguished_name.push(DnType::CommonName, cn);
        let csr = params.serialize_request(&key).expect("build CSR");
        csr.pem().expect("CSR PEM")
    }

    // ── constant_time_eq / verify_secret ─────────────────────────────────

    #[test]
    fn constant_time_eq_equal_bytes_match() {
        assert!(constant_time_eq(b"same-value", b"same-value"));
    }

    #[test]
    fn constant_time_eq_different_bytes_do_not_match() {
        assert!(!constant_time_eq(b"same-value", b"other-value"));
    }

    #[test]
    fn constant_time_eq_different_lengths_do_not_match() {
        assert!(!constant_time_eq(b"short", b"a-much-longer-value"));
    }

    #[test]
    fn constant_time_eq_empty_slices_match() {
        assert!(constant_time_eq(b"", b""));
    }

    #[test]
    fn verify_secret_matches_the_correct_value() {
        assert!(verify_secret("hunter2", "hunter2"));
    }

    #[test]
    fn verify_secret_rejects_the_wrong_value() {
        assert!(!verify_secret("wrong", "hunter2"));
    }

    /// An empty configured secret must reject EVERY caller, including one
    /// presenting an empty header — never "match on emptiness". This is the
    /// property the internal client-cert endpoint's fail-closed posture
    /// depends on.
    #[test]
    fn verify_secret_empty_expected_rejects_everything() {
        assert!(!verify_secret("", ""));
        assert!(!verify_secret("anything", ""));
    }

    /// The server DOES have a real secret configured — the caller is the one
    /// sending an empty-string header (present header, empty value; a client
    /// that forgot to set it, or a proxy that stripped the value but not the
    /// header). Must still reject, not rely purely on `constant_time_eq`'s
    /// length short-circuit being inferred from reading the code.
    #[test]
    fn verify_secret_empty_provided_against_a_real_configured_secret_is_rejected() {
        assert!(!verify_secret("", "a-real-configured-secret"));
    }

    // ── issue_client_cert handler ──────────────────────────────────────────

    const TEST_INTERNAL_SECRET: &str = "test-only-gateway-internal-secret";
    static INIT_INTERNAL_SECRET: std::sync::Once = std::sync::Once::new();

    /// Pin `GATEWAY_INTERNAL_SECRET` to one fixed known value for every test
    /// below that exercises `issue_client_cert`'s auth check.
    ///
    /// Safe under `cargo test`'s default parallelism even though
    /// `internal_secret()`'s `OnceLock` can only be initialized once per
    /// process: every caller of this function sets the SAME value before
    /// touching the handler, so whichever test thread's env write wins the
    /// race to initialize that `OnceLock`, the cached value is identical
    /// either way.
    fn ensure_internal_secret_configured() {
        INIT_INTERNAL_SECRET.call_once(|| {
            std::env::set_var("GATEWAY_INTERNAL_SECRET", TEST_INTERNAL_SECRET);
        });
    }

    fn header_map_with_secret(secret: &str) -> hyper::HeaderMap {
        let mut headers = hyper::HeaderMap::new();
        headers.insert(
            "x-gateway-secret",
            hyper::header::HeaderValue::from_str(secret).expect("valid header value"),
        );
        headers
    }

    #[tokio::test]
    async fn issue_client_cert_401s_without_the_secret_header() {
        ensure_internal_secret_configured();
        let state = test_gateway_state().await;
        let resp = issue_client_cert(
            State(state),
            hyper::HeaderMap::new(),
            axum::body::Bytes::from_static(b"{}"),
        )
        .await
        .into_response();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn issue_client_cert_401s_with_the_wrong_secret() {
        ensure_internal_secret_configured();
        let state = test_gateway_state().await;
        let resp = issue_client_cert(
            State(state),
            header_map_with_secret("not-the-right-secret"),
            axum::body::Bytes::from_static(b"{}"),
        )
        .await
        .into_response();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    /// The server has a REAL, non-empty `GATEWAY_INTERNAL_SECRET` configured
    /// (`ensure_internal_secret_configured` guarantees this for every test in
    /// this file) — the caller is the one sending an empty-string header
    /// value. Must still 401, exercised at the actual handler, not just
    /// inferred from `verify_secret`'s pure-function test above.
    #[tokio::test]
    async fn issue_client_cert_401s_with_an_empty_secret_header_against_a_configured_secret() {
        ensure_internal_secret_configured();
        let state = test_gateway_state().await;
        let resp = issue_client_cert(
            State(state),
            header_map_with_secret(""),
            axum::body::Bytes::from_static(b"{}"),
        )
        .await
        .into_response();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    /// An explicit cap ahead of axum's own default body limit — the auth
    /// check (which never inspects the body) must not mask this: a
    /// correctly authenticated caller sending an oversized body still gets
    /// rejected, before any JSON parsing is attempted.
    #[tokio::test]
    async fn issue_client_cert_413s_on_an_oversized_body_even_with_the_right_secret() {
        ensure_internal_secret_configured();
        let state = test_gateway_state().await;
        let oversized = axum::body::Bytes::from(vec![b'a'; MAX_CLIENT_CERT_REQUEST_BODY_BYTES + 1]);
        let resp = issue_client_cert(
            State(state),
            header_map_with_secret(TEST_INTERNAL_SECRET),
            oversized,
        )
        .await
        .into_response();
        assert_eq!(resp.status(), StatusCode::PAYLOAD_TOO_LARGE);
    }

    /// A body right at the cap is NOT rejected by the size check (only
    /// `> MAX`, matching the plan's "cap", not an off-by-one).
    #[tokio::test]
    async fn issue_client_cert_accepts_a_body_exactly_at_the_cap_past_the_size_check() {
        ensure_internal_secret_configured();
        let state = test_gateway_state().await;
        // Right at the cap, but not valid JSON — proves the size check let
        // it through (400 from the JSON parse), not a size rejection (413).
        let mut body = vec![b' '; MAX_CLIENT_CERT_REQUEST_BODY_BYTES];
        body[0] = b'{'; // still invalid JSON, deliberately, to isolate the check under test
        let resp = issue_client_cert(
            State(state),
            header_map_with_secret(TEST_INTERNAL_SECRET),
            axum::body::Bytes::from(body),
        )
        .await
        .into_response();
        assert_ne!(resp.status(), StatusCode::PAYLOAD_TOO_LARGE);
    }

    #[tokio::test]
    async fn issue_client_cert_503s_when_no_minting_authority_is_configured() {
        ensure_internal_secret_configured();
        // `test_gateway_state()` leaves `client_ca: None` — the "operator set
        // GATEWAY_CLIENT_CA, no matching key" case described on the field's
        // doc comment and implemented in `main.rs`.
        let state = test_gateway_state().await;
        let resp = issue_client_cert(
            State(state),
            header_map_with_secret(TEST_INTERNAL_SECRET),
            axum::body::Bytes::from_static(
                br#"{"host_id":"h","spiffe_uri":"spiffe://onecli/host/h","csr_pem":"x"}"#,
            ),
        )
        .await
        .into_response();
        assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);
    }

    #[tokio::test]
    async fn issue_client_cert_400s_on_malformed_json_with_a_valid_secret_and_authority() {
        ensure_internal_secret_configured();
        let mut state = test_gateway_state().await;
        state.client_ca = Some(Arc::new(test_client_ca().await));

        let resp = issue_client_cert(
            State(state),
            header_map_with_secret(TEST_INTERNAL_SECRET),
            axum::body::Bytes::from_static(b"not json"),
        )
        .await
        .into_response();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    }

    /// The full success path, through a real `ClientCa` authority: a fresh
    /// keypair's CSR gets a 200 with a cert chain (leaf + CA) and no key
    /// material anywhere in the response.
    #[tokio::test]
    async fn issue_client_cert_200s_and_mints_a_real_cert_on_success() {
        ensure_internal_secret_configured();
        let mut state = test_gateway_state().await;
        state.client_ca = Some(Arc::new(test_client_ca().await));

        let csr_pem = generate_csr_pem("test-host-1");
        let req_body = serde_json::json!({
            "host_id": "test-host-1",
            "spiffe_uri": "spiffe://onecli/host/test-host-1",
            "csr_pem": csr_pem,
        });

        let resp = issue_client_cert(
            State(state),
            header_map_with_secret(TEST_INTERNAL_SECRET),
            axum::body::Bytes::from(serde_json::to_vec(&req_body).unwrap()),
        )
        .await
        .into_response();
        assert_eq!(resp.status(), StatusCode::OK);

        let body_bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        let parsed: serde_json::Value = serde_json::from_slice(&body_bytes).unwrap();
        let cert_pem = parsed["cert_pem"].as_str().unwrap();
        let ca_pem = parsed["ca_pem"].as_str().unwrap();
        assert!(cert_pem.contains("-----BEGIN CERTIFICATE-----"));
        assert!(ca_pem.contains("-----BEGIN CERTIFICATE-----"));
        assert!(!parsed["serial_hex"].as_str().unwrap().is_empty());
        assert!(parsed["not_after_unix"].as_i64().unwrap() > 0);
        // No key field anywhere in the response.
        let keys: Vec<&str> = parsed.as_object().unwrap().keys().map(|s| s.as_str()).collect();
        assert_eq!(
            {
                let mut k = keys.clone();
                k.sort_unstable();
                k
            },
            vec!["ca_pem", "cert_pem", "not_after_unix", "serial_hex"]
        );
        for key in keys {
            let v = parsed[key].to_string();
            assert!(!v.contains("PRIVATE KEY"), "leaked key material in {key}");
        }
    }

    /// SECURITY regression: a CSR whose own subject/SAN differs from the
    /// server-supplied `host_id`/`spiffe_uri` must NOT influence the issued
    /// certificate — every identity field on the leaf is set from the
    /// request's `host_id`/`spiffe_uri` alone, never from the CSR's own
    /// (attacker-controlled) params. Verified by re-parsing the issued X.509
    /// and asserting the identity fields, not by reading the code.
    #[tokio::test]
    async fn issue_client_cert_ignores_the_csrs_own_identity_fields() {
        ensure_internal_secret_configured();
        let mut state = test_gateway_state().await;
        state.client_ca = Some(Arc::new(test_client_ca().await));

        // A CSR that itself claims a totally different identity.
        let csr_pem = generate_csr_pem("attacker-chosen-cn");
        let req_body = serde_json::json!({
            "host_id": "server-assigned-host",
            "spiffe_uri": "spiffe://onecli/host/server-assigned-host",
            "csr_pem": csr_pem,
        });

        let resp = issue_client_cert(
            State(state),
            header_map_with_secret(TEST_INTERNAL_SECRET),
            axum::body::Bytes::from(serde_json::to_vec(&req_body).unwrap()),
        )
        .await
        .into_response();
        assert_eq!(resp.status(), StatusCode::OK);

        let body_bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        let parsed: serde_json::Value = serde_json::from_slice(&body_bytes).unwrap();
        let cert_pem = parsed["cert_pem"].as_str().unwrap();

        let (_, pem) = x509_parser::pem::parse_x509_pem(cert_pem.as_bytes()).unwrap();
        let (_, cert) = x509_parser::parse_x509_certificate(&pem.contents).unwrap();
        let cn = cert
            .subject()
            .iter_common_name()
            .next()
            .and_then(|a| a.as_str().ok())
            .unwrap_or_default();
        assert_eq!(cn, "server-assigned-host");
        assert_ne!(cn, "attacker-chosen-cn");

        let uri_san = cert
            .subject_alternative_name()
            .ok()
            .flatten()
            .and_then(|ext| {
                ext.value.general_names.iter().find_map(|gn| match gn {
                    x509_parser::extensions::GeneralName::URI(uri) => Some(uri.to_string()),
                    _ => None,
                })
            })
            .unwrap_or_default();
        assert_eq!(uri_san, "spiffe://onecli/host/server-assigned-host");
    }

    #[tokio::test]
    async fn issue_client_cert_400s_on_a_garbage_csr() {
        ensure_internal_secret_configured();
        let mut state = test_gateway_state().await;
        state.client_ca = Some(Arc::new(test_client_ca().await));

        let req_body = serde_json::json!({
            "host_id": "h",
            "spiffe_uri": "spiffe://onecli/host/h",
            "csr_pem": "-----BEGIN CERTIFICATE REQUEST-----\nnot-a-real-csr\n-----END CERTIFICATE REQUEST-----\n",
        });

        let resp = issue_client_cert(
            State(state),
            header_map_with_secret(TEST_INTERNAL_SECRET),
            axum::body::Bytes::from(serde_json::to_vec(&req_body).unwrap()),
        )
        .await
        .into_response();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    }
}
