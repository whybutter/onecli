//! Config assembly and TLS server config construction for the mTLS listener.

use std::net::{IpAddr, Ipv4Addr};
use std::sync::Arc;

use anyhow::{bail, Context, Result};
use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use rustls::server::WebPkiClientVerifier;
use rustls::{RootCertStore, ServerConfig};

// ── PEM / root store loading ─────────────────────────────────────────────

/// Resolve a PEM value from a raw string: a value starting with `-----BEGIN`
/// is treated as inline PEM (cloud injects CA/cert/key material this way,
/// from Secrets Manager); anything else is treated as a filesystem path (OSS
/// mounts files). Empty or unset input is `Ok(None)` — the caller decides
/// whether that's fatal.
pub fn pem_from_value(var_name: &str, value: &str) -> Result<Option<String>> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    if trimmed.starts_with("-----BEGIN") {
        return Ok(Some(trimmed.to_string()));
    }
    std::fs::read_to_string(trimmed)
        .map(Some)
        .with_context(|| format!("reading {var_name} from path {trimmed}"))
}

/// Same as [`pem_from_value`], reading the raw value from the environment.
#[cfg_attr(not(test), allow(dead_code))]
fn pem_from_env(var_name: &str) -> Result<Option<String>> {
    match std::env::var(var_name) {
        Ok(value) => pem_from_value(var_name, &value),
        Err(_) => Ok(None),
    }
}

/// Parse every certificate out of a PEM bundle. Errors if the PEM is
/// malformed or contains zero certificates — a client CA file that parses to
/// nothing is a misconfiguration, not "no CAs trusted".
pub(crate) fn pem_to_der_certs(pem: &str) -> Result<Vec<CertificateDer<'static>>> {
    let mut reader = pem.as_bytes();
    let certs: Vec<CertificateDer<'static>> = rustls_pemfile::certs(&mut reader)
        .collect::<Result<_, _>>()
        .context("parsing PEM certificate(s)")?;
    if certs.is_empty() {
        bail!("no certificates found in PEM");
    }
    Ok(certs)
}

/// Extract the DER-encoded SubjectPublicKeyInfo (SPKI) from a certificate —
/// "is this the same key", not "is this byte-identical certificate". Used by
/// the MITM-CA-reuse guard in `from_parts`: a certificate can be re-issued or
/// re-encoded (different serial, validity window, or DN) while wrapping the
/// exact same key pair, which a whole-certificate DER comparison would miss.
fn spki_der(cert_der: &CertificateDer<'_>) -> Result<Vec<u8>> {
    let (_, cert) = x509_parser::parse_x509_certificate(cert_der.as_ref())
        .context("parsing certificate to extract its public key")?;
    Ok(cert.public_key().raw.to_vec())
}

/// Build a [`RootCertStore`] from a PEM bundle of one or more CA certificates.
/// Reused by later phases (e.g. reloading the client CA bundle on rotation).
pub fn load_client_ca_roots(pem: &str) -> Result<Arc<RootCertStore>> {
    let certs = pem_to_der_certs(pem)?;
    let mut store = RootCertStore::empty();
    for cert in certs {
        store
            .add(cert)
            .context("adding client CA certificate to root store")?;
    }
    Ok(Arc::new(store))
}

// ── Server config ─────────────────────────────────────────────────────────

/// Build the mTLS `ServerConfig`: the gateway's own cert/key for the TLS
/// server side, plus `roots` as the trust anchor(s) for verifying client
/// certificates.
pub(crate) fn build_server_config(
    cert_pem: &str,
    key_pem: &str,
    roots: Arc<RootCertStore>,
) -> Result<Arc<ServerConfig>> {
    let cert_chain = pem_to_der_certs(cert_pem).context("parsing GATEWAY_TLS_CERT")?;

    let mut key_reader = key_pem.as_bytes();
    let key: PrivateKeyDer<'static> = rustls_pemfile::private_key(&mut key_reader)
        .context("parsing GATEWAY_TLS_KEY")?
        .context("no private key found in GATEWAY_TLS_KEY")?;

    // SECURITY: no `.allow_unauthenticated()` on this builder. The builder's
    // default policy — reject any handshake that doesn't present a certificate
    // verifiable against `roots` — IS the "no cert -> rejected" guarantee this
    // whole module exists to provide. Do not add it, even for a "convenience"
    // fallback: that would silently reopen the plaintext-equivalent hole this
    // port is meant to close.
    let verifier = WebPkiClientVerifier::builder(roots)
        .build()
        .context("building client certificate verifier")?;

    let mut config = ServerConfig::builder()
        .with_client_cert_verifier(verifier)
        .with_single_cert(cert_chain, key)
        .context("building mTLS ServerConfig")?;

    // Force HTTP/1.1 — same rationale as the MITM leaf configs (`ca` crate):
    // prevent HTTP/2 negotiation via ALPN, since the gateway's connection
    // handling assumes HTTP/1.1 semantics (CONNECT interception, upgrades).
    config.alpn_protocols = vec![b"http/1.1".to_vec()];

    // Future hook: revocation lists would be wired in here via
    // `WebPkiClientVerifier::builder(roots).with_crls(...)`. Certificate
    // expiry is already validated by the webpki verifier itself — no manual
    // `not_after` check is needed (or added) on top of it.

    Ok(Arc::new(config))
}

// ── Config ────────────────────────────────────────────────────────────────

/// Resolved mTLS listener configuration. `None` (via [`MtlsConfig::from_env`])
/// means mTLS is off — the gateway runs exactly as it did before this crate
/// existed.
#[derive(Debug)]
pub struct MtlsConfig {
    pub port: u16,
    pub bind: IpAddr,
    pub server_config: Arc<ServerConfig>,
}

impl MtlsConfig {
    /// Build the mTLS config from already-resolved parts — no environment
    /// access, so this is the unit-testable core. `from_env` is a thin
    /// wrapper that reads the four env vars and forwards here.
    ///
    /// `port`/`cert`/`key`/`ca` are the raw `GATEWAY_MTLS_PORT` /
    /// `GATEWAY_TLS_CERT` / `GATEWAY_TLS_KEY` / `GATEWAY_CLIENT_CA` values
    /// (or `None` if unset) — inline PEM or filesystem path, resolved here via
    /// [`pem_from_value`]. `mitm_ca_der` is the gateway's own MITM CA
    /// certificate DER (the `ca` crate has no `ca_cert_der()` accessor, so
    /// `from_env` parses it from `ca_cert_pem()`'s output instead — see that
    /// function); `plain_port` is the plaintext listener port.
    ///
    /// `fallback_client_ca_pem`: when `ca` (`GATEWAY_CLIENT_CA`) is unset,
    /// this PEM is used as the client-CA trust anchor instead of erroring —
    /// it's `main`'s generated/loaded `client_ca::ClientCa` certificate, so a
    /// fresh OSS install trusts (and can mint against) its own client CA with
    /// zero configuration. An explicit `GATEWAY_CLIENT_CA` always wins over
    /// this fallback: an operator who has configured their own external trust
    /// anchor is never silently overridden.
    ///
    /// `Ok(None)` means mTLS is off (port unset). Every other failure mode —
    /// unparseable/zero/colliding port, missing material (with no fallback to
    /// cover it), unreadable/garbage PEM, or a client CA that IS the MITM CA —
    /// is `Err`, and the caller (`main`) must fail closed: never fall back to
    /// plaintext-only when mTLS was requested but couldn't be built.
    #[allow(clippy::too_many_arguments)]
    pub fn from_parts(
        port: Option<&str>,
        cert: Option<&str>,
        key: Option<&str>,
        ca: Option<&str>,
        fallback_client_ca_pem: Option<&str>,
        mitm_ca_der: &CertificateDer<'static>,
        plain_port: u16,
    ) -> Result<Option<MtlsConfig>> {
        let Some(port_str) = port else {
            // GATEWAY_MTLS_PORT unset: mTLS is off. Full backward compatibility.
            return Ok(None);
        };

        let port: u16 = port_str.parse().with_context(|| {
            format!("GATEWAY_MTLS_PORT {port_str:?} is not a valid port number")
        })?;
        if port == 0 {
            bail!("GATEWAY_MTLS_PORT must not be 0");
        }
        if port == plain_port {
            bail!(
                "GATEWAY_MTLS_PORT ({port}) must differ from the plaintext gateway port ({plain_port})"
            );
        }

        let cert_pem = cert
            .context("GATEWAY_TLS_CERT is required when GATEWAY_MTLS_PORT is set")
            .and_then(|v| pem_from_value("GATEWAY_TLS_CERT", v))?
            .context("GATEWAY_TLS_CERT is required when GATEWAY_MTLS_PORT is set")?;
        let key_pem = key
            .context("GATEWAY_TLS_KEY is required when GATEWAY_MTLS_PORT is set")
            .and_then(|v| pem_from_value("GATEWAY_TLS_KEY", v))?
            .context("GATEWAY_TLS_KEY is required when GATEWAY_MTLS_PORT is set")?;

        // GATEWAY_CLIENT_CA explicit env value takes precedence; only fall
        // back to the generated authority's cert when it's genuinely unset
        // (or set-but-empty, which `pem_from_value` already treats as unset).
        let ca_from_env = match ca {
            Some(v) => pem_from_value("GATEWAY_CLIENT_CA", v)?,
            None => None,
        };
        let ca_pem = match ca_from_env {
            Some(pem) => pem,
            None => fallback_client_ca_pem
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .context(
                    "GATEWAY_CLIENT_CA is required when GATEWAY_MTLS_PORT is set (and no \
                     generated client-CA authority is available as a fallback)",
                )?
                .to_string(),
        };

        // SECURITY: reject a client CA bundle that carries the same public
        // key as the gateway's own MITM CA. Compared on the DER-encoded
        // SubjectPublicKeyInfo (SPKI), not the whole-certificate DER: the real
        // risk is the MITM CA's *private key* being host-resident (it signs a
        // fresh leaf for every intercepted domain), and a re-issued or
        // re-encoded certificate wrapping that SAME key would byte-differ
        // from the original cert while remaining exactly as dangerous to
        // trust — a whole-cert comparison would miss it. If ANY certificate
        // carrying that key were trusted as a client-cert anchor, anyone able
        // to mint a MITM leaf could just as easily mint a "valid" client cert
        // and impersonate any agent.
        let mitm_spki =
            spki_der(mitm_ca_der).context("parsing the gateway's own MITM CA certificate")?;
        let ca_certs = pem_to_der_certs(&ca_pem).context("parsing GATEWAY_CLIENT_CA")?;
        for cert in &ca_certs {
            let spki = spki_der(cert)
                .context("GATEWAY_CLIENT_CA contains a certificate that failed to parse")?;
            if spki == mitm_spki {
                bail!(
                    "GATEWAY_CLIENT_CA must not include a certificate carrying the same public \
                     key as the gateway's own MITM CA (its private key lives on this host, so \
                     trusting that key as a client anchor would let anyone mint their own \
                     client certificate)"
                );
            }
        }

        let roots = load_client_ca_roots(&ca_pem).context("GATEWAY_CLIENT_CA")?;
        let server_config = build_server_config(&cert_pem, &key_pem, roots)?;

        Ok(Some(MtlsConfig {
            port,
            bind: IpAddr::V4(Ipv4Addr::UNSPECIFIED),
            server_config,
        }))
    }

    /// Read `GATEWAY_MTLS_PORT` / `GATEWAY_TLS_CERT` / `GATEWAY_TLS_KEY` /
    /// `GATEWAY_CLIENT_CA` from the environment and forward to
    /// [`Self::from_parts`], along with `fallback_client_ca_pem` (see its doc
    /// there) which `main` supplies when it holds a generated
    /// `client_ca::ClientCa`.
    ///
    /// `mitm_ca_pem` is the gateway's own MITM CA certificate as PEM
    /// (`ca::CertificateAuthority::ca_cert_pem()` — the `ca` crate has no
    /// `ca_cert_der()` accessor) — parsed back to DER here so `from_parts`'s
    /// SPKI guard has something to compare against.
    pub fn from_env(
        mitm_ca_pem: &str,
        plain_port: u16,
        fallback_client_ca_pem: Option<&str>,
    ) -> Result<Option<MtlsConfig>> {
        let mitm_ca_der = pem_to_der_certs(mitm_ca_pem)
            .context("parsing the gateway's own MITM CA certificate")?
            .into_iter()
            .next()
            .context("the gateway's own MITM CA PEM contains no certificate")?;

        let port = std::env::var("GATEWAY_MTLS_PORT").ok();
        let cert = std::env::var("GATEWAY_TLS_CERT").ok();
        let key = std::env::var("GATEWAY_TLS_KEY").ok();
        let ca = std::env::var("GATEWAY_CLIENT_CA").ok();
        Self::from_parts(
            port.as_deref(),
            cert.as_deref(),
            key.as_deref(),
            ca.as_deref(),
            fallback_client_ca_pem,
            &mitm_ca_der,
            plain_port,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity::identity_from_peer_certs;
    use crate::test_support::*;
    use std::io::Write;
    use std::time::{SystemTime, UNIX_EPOCH};

    use rcgen::{
        BasicConstraints, CertificateParams, DnType, IsCa, KeyPair, PKCS_ECDSA_P256_SHA256,
    };
    use time::OffsetDateTime;

    // ── Handshake behavior ────────────────────────────────────────────────

    #[tokio::test]
    async fn handshake_rejects_missing_client_cert() {
        ensure_crypto_provider();
        let ca = new_test_ca("Test Client CA");
        let ca_pem = ca.cert.pem();
        let (server_config, server_der) = test_server_setup(&ca_pem);
        let client_config = test_client_config(&server_der, None, None);

        let result = attempt_handshake(server_config, client_config).await;
        let err = result.expect_err("handshake without a client cert must fail");
        assert!(
            err_debug_contains(&err, "NoCertificatesPresented")
                || err_debug_contains(&err, "CertificateRequired"),
            "unexpected error: {err:?}"
        );
    }

    #[tokio::test]
    async fn handshake_rejects_wrong_ca() {
        ensure_crypto_provider();
        let trusted_ca = new_test_ca("Trusted Client CA");
        let other_ca = new_test_ca("Some Other CA");
        let (cert_pem, key_pem) = sign_client_leaf(&other_ca, Some("agent-1"), &[], -1, 24);

        let (server_config, server_der) = test_server_setup(&trusted_ca.cert.pem());
        let client_config = test_client_config(&server_der, Some(&cert_pem), Some(&key_pem));

        let result = attempt_handshake(server_config, client_config).await;
        let err = result.expect_err("handshake signed by an untrusted CA must fail");
        assert!(
            err_debug_contains(&err, "UnknownIssuer"),
            "unexpected error: {err:?}"
        );
    }

    #[tokio::test]
    async fn handshake_rejects_expired_cert() {
        ensure_crypto_provider();
        let ca = new_test_ca("Trusted Client CA");
        // Valid window entirely in the past.
        let (cert_pem, key_pem) = sign_client_leaf(&ca, Some("agent-1"), &[], -48, -24);

        let (server_config, server_der) = test_server_setup(&ca.cert.pem());
        let client_config = test_client_config(&server_der, Some(&cert_pem), Some(&key_pem));

        let result = attempt_handshake(server_config, client_config).await;
        let err = result.expect_err("handshake with an expired client cert must fail");
        assert!(
            err_debug_contains(&err, "Expired"),
            "unexpected error: {err:?}"
        );
    }

    #[tokio::test]
    async fn handshake_accepts_valid_cert_with_uri_san() {
        ensure_crypto_provider();
        let ca = new_test_ca("Trusted Client CA");
        let (cert_pem, key_pem) = sign_client_leaf(
            &ca,
            Some("fallback-cn"),
            &["spiffe://onecli/agent/1"],
            -1,
            24,
        );

        let (server_config, server_der) = test_server_setup(&ca.cert.pem());
        let client_config = test_client_config(&server_der, Some(&cert_pem), Some(&key_pem));

        let mut tls_stream = attempt_handshake(server_config, client_config)
            .await
            .expect("valid client cert must be accepted");

        let identity = tls_stream
            .get_ref()
            .1
            .peer_certificates()
            .and_then(identity_from_peer_certs)
            .expect("identity must be extracted");
        assert_eq!(identity.primary(), Some("spiffe://onecli/agent/1"));
        assert_eq!(identity.cn.as_deref(), Some("fallback-cn"));

        // Drain so the client side's write half doesn't hang the test.
        use tokio::io::AsyncWriteExt;
        let _ = tls_stream.shutdown().await;
    }

    #[tokio::test]
    async fn handshake_accepts_valid_cert_cn_only() {
        ensure_crypto_provider();
        let ca = new_test_ca("Trusted Client CA");
        let (cert_pem, key_pem) = sign_client_leaf(&ca, Some("cn-only-agent"), &[], -1, 24);

        let (server_config, server_der) = test_server_setup(&ca.cert.pem());
        let client_config = test_client_config(&server_der, Some(&cert_pem), Some(&key_pem));

        let mut tls_stream = attempt_handshake(server_config, client_config)
            .await
            .expect("valid client cert must be accepted");

        let identity = tls_stream
            .get_ref()
            .1
            .peer_certificates()
            .and_then(identity_from_peer_certs)
            .expect("identity must be extracted");
        assert_eq!(identity.primary(), Some("cn-only-agent"));
        assert!(identity.uri_sans.is_empty());

        use tokio::io::AsyncWriteExt;
        let _ = tls_stream.shutdown().await;
    }

    #[tokio::test]
    async fn server_config_pins_http11_alpn() {
        ensure_crypto_provider();
        let ca = new_test_ca("Trusted Client CA");
        let (config, _server_der) = test_server_setup(&ca.cert.pem());
        assert_eq!(config.alpn_protocols, vec![b"http/1.1".to_vec()]);
    }

    // ── from_parts: no env access ────────────────────────────────────────

    fn dummy_mitm_ca_der() -> CertificateDer<'static> {
        new_test_ca("Dummy MITM CA").der
    }

    #[test]
    fn from_parts_port_none_is_off() {
        ensure_crypto_provider();
        let mitm_der = dummy_mitm_ca_der();
        let result =
            MtlsConfig::from_parts(None, None, None, None, None, &mitm_der, 10255).unwrap();
        assert!(result.is_none());
    }

    /// Stands in for "this field is present" in `from_parts` tests that only
    /// care about a *different* field. Must start with `-----BEGIN` so
    /// `pem_from_value` takes the inline-PEM branch rather than trying (and
    /// failing) to read it as a filesystem path — its content is never
    /// actually parsed in these tests, since the function under test returns
    /// before reaching that point.
    const PRESENT_PLACEHOLDER_PEM: &str =
        "-----BEGIN CERTIFICATE-----\nplaceholder\n-----END CERTIFICATE-----\n";

    #[test]
    fn from_parts_missing_cert_errs_naming_it() {
        ensure_crypto_provider();
        let mitm_der = dummy_mitm_ca_der();
        let err = MtlsConfig::from_parts(
            Some("10256"),
            None,
            Some("key"),
            Some("ca"),
            None,
            &mitm_der,
            10255,
        )
        .unwrap_err();
        assert!(format!("{err:#}").contains("GATEWAY_TLS_CERT"));
    }

    #[test]
    fn from_parts_missing_key_errs_naming_it() {
        ensure_crypto_provider();
        let mitm_der = dummy_mitm_ca_der();
        let err = MtlsConfig::from_parts(
            Some("10256"),
            Some(PRESENT_PLACEHOLDER_PEM),
            None,
            Some(PRESENT_PLACEHOLDER_PEM),
            None,
            &mitm_der,
            10255,
        )
        .unwrap_err();
        assert!(format!("{err:#}").contains("GATEWAY_TLS_KEY"));
    }

    #[test]
    fn from_parts_missing_ca_errs_naming_it() {
        ensure_crypto_provider();
        let mitm_der = dummy_mitm_ca_der();
        let err = MtlsConfig::from_parts(
            Some("10256"),
            Some(PRESENT_PLACEHOLDER_PEM),
            Some(PRESENT_PLACEHOLDER_PEM),
            None,
            None,
            &mitm_der,
            10255,
        )
        .unwrap_err();
        assert!(format!("{err:#}").contains("GATEWAY_CLIENT_CA"));
    }

    #[test]
    fn from_parts_zero_port_errs() {
        ensure_crypto_provider();
        let mitm_der = dummy_mitm_ca_der();
        let err = MtlsConfig::from_parts(
            Some("0"),
            Some("c"),
            Some("k"),
            Some("a"),
            None,
            &mitm_der,
            10255,
        )
        .unwrap_err();
        assert!(format!("{err:#}").contains("must not be 0"));
    }

    #[test]
    fn from_parts_garbage_port_errs() {
        ensure_crypto_provider();
        let mitm_der = dummy_mitm_ca_der();
        let err = MtlsConfig::from_parts(
            Some("not-a-port"),
            Some("c"),
            Some("k"),
            Some("a"),
            None,
            &mitm_der,
            10255,
        )
        .unwrap_err();
        assert!(format!("{err:#}").contains("not a valid port"));
    }

    #[test]
    fn from_parts_port_equals_plain_port_errs() {
        ensure_crypto_provider();
        let mitm_der = dummy_mitm_ca_der();
        let err = MtlsConfig::from_parts(
            Some("10255"),
            Some("c"),
            Some("k"),
            Some("a"),
            None,
            &mitm_der,
            10255,
        )
        .unwrap_err();
        assert!(format!("{err:#}").contains("must differ"));
    }

    #[test]
    fn from_parts_loads_inline_pem_and_path_forms() {
        ensure_crypto_provider();
        let ca = new_test_ca("Trusted Client CA");
        let (server_cert_pem, server_key_pem, _) = self_signed_server_cert();
        let mitm_der = dummy_mitm_ca_der();
        let ca_pem = ca.cert.pem();

        // Inline PEM form for all three.
        let result = MtlsConfig::from_parts(
            Some("10256"),
            Some(&server_cert_pem),
            Some(&server_key_pem),
            Some(&ca_pem),
            None,
            &mitm_der,
            10255,
        )
        .expect("inline PEM must load");
        assert!(result.is_some());

        // Path form: write each to a tempfile and pass the path.
        let dir = tempfile::tempdir().expect("tempdir");
        let cert_path = dir.path().join("cert.pem");
        let key_path = dir.path().join("key.pem");
        let ca_path = dir.path().join("ca.pem");
        std::fs::write(&cert_path, &server_cert_pem).expect("write cert");
        std::fs::write(&key_path, &server_key_pem).expect("write key");
        std::fs::write(&ca_path, &ca_pem).expect("write ca");

        let result = MtlsConfig::from_parts(
            Some("10256"),
            Some(cert_path.to_str().unwrap()),
            Some(key_path.to_str().unwrap()),
            Some(ca_path.to_str().unwrap()),
            None,
            &mitm_der,
            10255,
        )
        .expect("path form must load");
        assert!(result.is_some());
    }

    #[test]
    fn from_parts_bad_path_errs() {
        ensure_crypto_provider();
        let mitm_der = dummy_mitm_ca_der();
        let err = MtlsConfig::from_parts(
            Some("10256"),
            Some("/nonexistent/path/cert.pem"),
            Some("/nonexistent/path/key.pem"),
            Some("/nonexistent/path/ca.pem"),
            None,
            &mitm_der,
            10255,
        )
        .unwrap_err();
        assert!(format!("{err:#}").contains("GATEWAY_TLS_CERT"));
    }

    #[test]
    fn from_parts_garbage_pem_errs() {
        ensure_crypto_provider();
        let mitm_der = dummy_mitm_ca_der();
        let (server_cert_pem, server_key_pem, _) = self_signed_server_cert();
        let err = MtlsConfig::from_parts(
            Some("10256"),
            Some(&server_cert_pem),
            Some(&server_key_pem),
            Some("-----BEGIN CERTIFICATE-----\nbm90IGEgY2VydA==\n-----END CERTIFICATE-----\n"),
            None,
            &mitm_der,
            10255,
        )
        .unwrap_err();
        assert!(format!("{err:#}").contains("GATEWAY_CLIENT_CA"));
    }

    #[test]
    fn from_parts_empty_client_ca_errs() {
        ensure_crypto_provider();
        let mitm_der = dummy_mitm_ca_der();
        let (server_cert_pem, server_key_pem, _) = self_signed_server_cert();
        // Empty value resolves to None via pem_from_value, which is then the
        // "missing" case for a mandatory var.
        let err = MtlsConfig::from_parts(
            Some("10256"),
            Some(&server_cert_pem),
            Some(&server_key_pem),
            Some(""),
            None,
            &mitm_der,
            10255,
        )
        .unwrap_err();
        assert!(format!("{err:#}").contains("GATEWAY_CLIENT_CA"));
    }

    #[test]
    fn from_parts_rejects_client_ca_matching_mitm_ca() {
        ensure_crypto_provider();
        let mitm_ca = new_test_ca("Gateway MITM CA");
        let (server_cert_pem, server_key_pem, _) = self_signed_server_cert();

        // GATEWAY_CLIENT_CA is (accidentally) the same cert as the MITM CA.
        let err = MtlsConfig::from_parts(
            Some("10256"),
            Some(&server_cert_pem),
            Some(&server_key_pem),
            Some(&mitm_ca.cert.pem()),
            None,
            &mitm_ca.der,
            10255,
        )
        .unwrap_err();
        assert!(format!("{err:#}").contains("MITM CA"));
    }

    /// The guard compares public keys (SPKI), not whole-certificate DER — a
    /// certificate carrying the SAME key as the MITM CA must still be
    /// rejected even though it's a byte-different certificate (different CN,
    /// serial, and validity window — e.g. a re-issued or re-encoded cert).
    #[test]
    fn from_parts_rejects_client_ca_with_same_public_key_as_mitm_ca_even_if_cert_differs() {
        ensure_crypto_provider();

        let mitm_key = KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256).expect("mitm key");
        let mut mitm_params = CertificateParams::default();
        mitm_params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
        mitm_params
            .distinguished_name
            .push(DnType::CommonName, "Gateway MITM CA");
        mitm_params.not_before = OffsetDateTime::now_utc() - time::Duration::hours(1);
        mitm_params.not_after = OffsetDateTime::now_utc() + time::Duration::days(3650);
        let mitm_cert = mitm_params.self_signed(&mitm_key).expect("self-sign mitm");
        let mitm_der = mitm_cert.der().clone();

        // A DIFFERENT certificate — different CN, serial, and validity window
        // (as a re-issued cert would be) — but signed with the SAME key pair.
        let mut reissued_params = CertificateParams::default();
        reissued_params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
        reissued_params
            .distinguished_name
            .push(DnType::CommonName, "Totally Unrelated Client CA");
        reissued_params.not_before = OffsetDateTime::now_utc() - time::Duration::hours(2);
        reissued_params.not_after = OffsetDateTime::now_utc() + time::Duration::days(30);
        let reissued_cert = reissued_params
            .self_signed(&mitm_key)
            .expect("self-sign reissued cert with the same key");

        // Sanity check: the two certs must NOT be byte-identical — otherwise
        // this test would exercise the same path as the whole-DER case above
        // and prove nothing new.
        assert_ne!(reissued_cert.der().as_ref(), mitm_der.as_ref());

        let (server_cert_pem, server_key_pem, _) = self_signed_server_cert();
        let err = MtlsConfig::from_parts(
            Some("10256"),
            Some(&server_cert_pem),
            Some(&server_key_pem),
            Some(&reissued_cert.pem()),
            None,
            &mitm_der,
            10255,
        )
        .unwrap_err();
        assert!(format!("{err:#}").contains("GATEWAY_CLIENT_CA"));
        assert!(format!("{err:#}").contains("public"));
    }

    // ── fallback_client_ca_pem (generated client-CA authority) ──────────

    /// When `GATEWAY_CLIENT_CA` is unset, the caller-supplied fallback (the
    /// generated `client_ca::ClientCa`'s own cert) is used instead of
    /// erroring — a fresh install trusts its own generated client CA with
    /// zero configuration.
    #[test]
    fn from_parts_uses_fallback_client_ca_when_env_unset() {
        ensure_crypto_provider();
        let mitm_der = dummy_mitm_ca_der();
        let (server_cert_pem, server_key_pem, _) = self_signed_server_cert();
        let generated_client_ca = new_test_ca("Generated Client CA");
        let fallback_pem = generated_client_ca.cert.pem();

        let result = MtlsConfig::from_parts(
            Some("10256"),
            Some(&server_cert_pem),
            Some(&server_key_pem),
            None,
            Some(&fallback_pem),
            &mitm_der,
            10255,
        )
        .expect("fallback client CA must be accepted when GATEWAY_CLIENT_CA is unset");
        assert!(result.is_some());
    }

    /// An explicit `GATEWAY_CLIENT_CA` always wins over the fallback — an
    /// operator's own configured trust anchor is never silently replaced by
    /// the gateway's generated one. Proven end to end: the resolved
    /// `server_config` accepts a leaf from the explicit CA and rejects one
    /// from the fallback (generated) CA.
    #[tokio::test]
    async fn from_parts_explicit_client_ca_wins_over_fallback() {
        ensure_crypto_provider();
        let mitm_der = dummy_mitm_ca_der();
        let (server_cert_pem, server_key_pem, server_der) = self_signed_server_cert();
        let explicit_ca = new_test_ca("Explicit Operator CA");
        let generated_client_ca = new_test_ca("Generated Client CA");

        let mtls = MtlsConfig::from_parts(
            Some("10256"),
            Some(&server_cert_pem),
            Some(&server_key_pem),
            Some(&explicit_ca.cert.pem()),
            Some(&generated_client_ca.cert.pem()),
            &mitm_der,
            10255,
        )
        .expect("explicit GATEWAY_CLIENT_CA must load")
        .expect("mTLS configured");

        // Rejected: signed by the fallback (generated) CA, which lost.
        let (fallback_cert_pem, fallback_key_pem) =
            sign_client_leaf(&generated_client_ca, Some("agent-1"), &[], -1, 24);
        let fallback_client_config = test_client_config(
            &server_der,
            Some(&fallback_cert_pem),
            Some(&fallback_key_pem),
        );
        let rejected =
            attempt_handshake(Arc::clone(&mtls.server_config), fallback_client_config).await;
        assert!(
            rejected.is_err(),
            "a leaf from the losing fallback CA must be rejected"
        );

        // Accepted: signed by the explicit CA, which won.
        let (explicit_cert_pem, explicit_key_pem) =
            sign_client_leaf(&explicit_ca, Some("agent-1"), &[], -1, 24);
        let explicit_client_config = test_client_config(
            &server_der,
            Some(&explicit_cert_pem),
            Some(&explicit_key_pem),
        );
        attempt_handshake(mtls.server_config, explicit_client_config)
            .await
            .expect("a leaf from the winning explicit CA must be accepted");
    }

    /// Both `GATEWAY_CLIENT_CA` and the fallback absent is still an error —
    /// the fallback is a convenience, not a way to silently skip validation.
    #[test]
    fn from_parts_errs_when_both_ca_and_fallback_absent() {
        ensure_crypto_provider();
        let mitm_der = dummy_mitm_ca_der();
        let err = MtlsConfig::from_parts(
            Some("10256"),
            Some(PRESENT_PLACEHOLDER_PEM),
            Some(PRESENT_PLACEHOLDER_PEM),
            None,
            None,
            &mitm_der,
            10255,
        )
        .unwrap_err();
        assert!(format!("{err:#}").contains("GATEWAY_CLIENT_CA"));
    }

    // ── pem_from_env / pem_from_value ────────────────────────────────────

    #[test]
    fn pem_from_value_empty_is_none() {
        assert_eq!(pem_from_value("X", "").unwrap(), None);
        assert_eq!(pem_from_value("X", "   ").unwrap(), None);
    }

    #[test]
    fn pem_from_value_inline_pem_passthrough() {
        // Leading/trailing whitespace around the value is trimmed (matching
        // `ca::CertificateAuthority::load_from_pem`), so assert against the
        // trimmed form.
        let pem = "-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----\n";
        assert_eq!(
            pem_from_value("X", pem).unwrap(),
            Some(pem.trim().to_string())
        );
    }

    #[test]
    fn pem_from_value_reads_path() {
        let mut file = tempfile::NamedTempFile::new().expect("tempfile");
        write!(file, "file-contents").expect("write");
        let path = file.path().to_str().unwrap();
        assert_eq!(
            pem_from_value("X", path).unwrap(),
            Some("file-contents".to_string())
        );
    }

    #[test]
    fn pem_from_value_bad_path_errs() {
        let err = pem_from_value("GATEWAY_TLS_CERT", "/no/such/file.pem").unwrap_err();
        assert!(format!("{err:#}").contains("GATEWAY_TLS_CERT"));
        assert!(format!("{err:#}").contains("/no/such/file.pem"));
    }

    #[test]
    fn pem_from_env_unset_is_none() {
        // A var name essentially guaranteed not to be set.
        assert_eq!(
            pem_from_env("GATEWAY_CA_TEST_DOES_NOT_EXIST_XYZ").unwrap(),
            None
        );
    }

    // ── load_client_ca_roots ──────────────────────────────────────────────

    #[test]
    fn load_client_ca_roots_empty_pem_errs() {
        assert!(load_client_ca_roots("").is_err());
    }

    #[test]
    fn load_client_ca_roots_garbage_errs() {
        assert!(load_client_ca_roots("not pem at all").is_err());
    }

    #[test]
    fn load_client_ca_roots_valid_pem_ok() {
        let ca = new_test_ca("Trusted Client CA");
        assert!(load_client_ca_roots(&ca.cert.pem()).is_ok());
    }

    // Sanity: not_after_unix reflects the certificate's actual expiry, so a
    // "certificate expires in ~1 day" leaf really does report a timestamp
    // roughly a day in the future (the verifier — not this field — is what
    // rejects expired certs; this just confirms the value is meaningful for
    // callers to build on).
    #[tokio::test]
    async fn identity_not_after_matches_leaf_validity() {
        ensure_crypto_provider();
        let ca = new_test_ca("Trusted Client CA");
        let (cert_pem, key_pem) = sign_client_leaf(&ca, Some("agent-1"), &[], -1, 24);
        let (server_config, server_der) = test_server_setup(&ca.cert.pem());
        let client_config = test_client_config(&server_der, Some(&cert_pem), Some(&key_pem));

        let mut tls_stream = attempt_handshake(server_config, client_config)
            .await
            .expect("valid cert accepted");
        let identity = tls_stream
            .get_ref()
            .1
            .peer_certificates()
            .and_then(identity_from_peer_certs)
            .expect("identity extracted");

        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;
        // Leaf expires ~24h from now; allow generous slack for test runtime.
        assert!(identity.not_after_unix > now);
        assert!(identity.not_after_unix < now + 25 * 3600);

        use tokio::io::AsyncWriteExt;
        let _ = tls_stream.shutdown().await;
    }
}
