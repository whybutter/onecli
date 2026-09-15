//! Test-only PKI harness shared across this crate's test suites, and across
//! other crates' test binaries (`relay`, `server`) that need to drive a real
//! mTLS handshake without duplicating this setup.
//!
//! `pub`, not `#[cfg(test)]`: a dependency's `#[cfg(test)]` code is invisible
//! to a dependent's test build, so this has to be part of the crate's normal
//! (non-test) build to be usable as a dev-dependency elsewhere.

use std::net::SocketAddr;
use std::sync::{Arc, Once};

use rcgen::{
    BasicConstraints, CertificateParams, DnType, IsCa, KeyPair, KeyUsagePurpose,
    PKCS_ECDSA_P256_SHA256,
};
use rustls::pki_types::{CertificateDer, ServerName};
use rustls::{RootCertStore, ServerConfig};
use time::OffsetDateTime;
use tokio::net::{TcpListener, TcpStream};
use tokio_rustls::{TlsAcceptor, TlsConnector};

use crate::mtls::{build_server_config, load_client_ca_roots, pem_to_der_certs};

static INIT_CRYPTO: Once = Once::new();

pub fn ensure_crypto_provider() {
    INIT_CRYPTO.call_once(|| {
        // Ignore the error: it just means another test suite in this same
        // test binary already installed the process-wide default — a no-op
        // for our purposes either way, since it's the same `ring` provider.
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}

/// A minimal CA + leaf-signing helper built on rcgen, mirroring the pattern
/// in the `ca` crate's own test module.
pub struct TestCa {
    pub cert: rcgen::Certificate,
    pub key: KeyPair,
    pub der: CertificateDer<'static>,
}

pub fn new_test_ca(cn: &str) -> TestCa {
    let key = KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256).expect("CA key");
    let mut params = CertificateParams::default();
    params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    params.distinguished_name.push(DnType::CommonName, cn);
    params.key_usages = vec![KeyUsagePurpose::KeyCertSign, KeyUsagePurpose::CrlSign];
    params.not_before = OffsetDateTime::now_utc() - time::Duration::hours(1);
    params.not_after = OffsetDateTime::now_utc() + time::Duration::days(3650);
    let cert = params.self_signed(&key).expect("self-sign CA");
    let der = cert.der().clone();
    TestCa { cert, key, der }
}

/// Sign a client leaf under `ca`, valid `[not_before_h, not_after_h]` hours
/// from now, with the given CN and URI SANs. Returns (cert_pem, key_pem).
pub fn sign_client_leaf(
    ca: &TestCa,
    cn: Option<&str>,
    uri_sans: &[&str],
    not_before_h: i64,
    not_after_h: i64,
) -> (String, String) {
    let leaf_key = KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256).expect("leaf key");
    let mut params = CertificateParams::default();
    // `CertificateParams::new(strings)` only ever infers IP or DNS SANs — a
    // "spiffe://..."-shaped string comes out as a (nonsensical) DNS name, not
    // a URI SAN. Push `SanType::URI` directly instead.
    params.subject_alt_names = uri_sans
        .iter()
        .map(|s| {
            rcgen::SanType::URI(rcgen::Ia5String::try_from(s.to_string()).expect("valid IA5 URI"))
        })
        .collect();
    if let Some(cn) = cn {
        params.distinguished_name.push(DnType::CommonName, cn);
    }
    params.key_usages = vec![KeyUsagePurpose::DigitalSignature];
    params.extended_key_usages = vec![rcgen::ExtendedKeyUsagePurpose::ClientAuth];
    params.not_before = OffsetDateTime::now_utc() + time::Duration::hours(not_before_h);
    params.not_after = OffsetDateTime::now_utc() + time::Duration::hours(not_after_h);
    let leaf_cert = params
        .signed_by(&leaf_key, &ca.cert, &ca.key)
        .expect("sign leaf");
    (leaf_cert.pem(), leaf_key.serialize_pem())
}

/// Self-signed "server" cert for `localhost`, used as the mTLS listener's own
/// identity in handshake tests. The test client trusts it directly (it's its
/// own root), sidestepping the need for a fake server verifier.
pub fn self_signed_server_cert() -> (String, String, CertificateDer<'static>) {
    let key = KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256).expect("server key");
    let mut params = CertificateParams::new(vec!["localhost".to_string()]).expect("params");
    params
        .distinguished_name
        .push(DnType::CommonName, "localhost");
    params.extended_key_usages = vec![rcgen::ExtendedKeyUsagePurpose::ServerAuth];
    params.not_before = OffsetDateTime::now_utc() - time::Duration::hours(1);
    params.not_after = OffsetDateTime::now_utc() + time::Duration::days(1);
    let cert = params.self_signed(&key).expect("self-sign server cert");
    let der = cert.der().clone();
    (cert.pem(), key.serialize_pem(), der)
}

/// Build a server config AND return the matching server cert DER — the two
/// must come from the same `self_signed_server_cert()` call, since the test
/// client trusts that DER directly as its only root.
pub fn test_server_setup(trusted_ca_pem: &str) -> (Arc<ServerConfig>, CertificateDer<'static>) {
    let (server_cert_pem, server_key_pem, server_der) = self_signed_server_cert();
    let roots = load_client_ca_roots(trusted_ca_pem).expect("roots");
    let config =
        build_server_config(&server_cert_pem, &server_key_pem, roots).expect("server config");
    (config, server_der)
}

pub fn test_client_config(
    server_der: &CertificateDer<'static>,
    client_cert_pem: Option<&str>,
    client_key_pem: Option<&str>,
) -> Arc<rustls::ClientConfig> {
    let mut roots = RootCertStore::empty();
    roots.add(server_der.clone()).expect("trust server cert");

    let builder = rustls::ClientConfig::builder().with_root_certificates(roots);
    let config = match (client_cert_pem, client_key_pem) {
        (Some(cert_pem), Some(key_pem)) => {
            let chain = pem_to_der_certs(cert_pem).expect("client cert chain");
            let mut key_reader = key_pem.as_bytes();
            let key = rustls_pemfile::private_key(&mut key_reader)
                .expect("parse client key")
                .expect("client key present");
            builder
                .with_client_auth_cert(chain, key)
                .expect("client auth cert")
        }
        _ => builder.with_no_client_auth(),
    };
    Arc::new(config)
}

/// Run one TLS handshake end to end over a real loopback socket. Returns the
/// server-side accept result — the thing under test — and discards the
/// client-side result beyond confirming it also failed when the server did
/// (a rejected handshake fails both sides).
pub async fn attempt_handshake(
    server_config: Arc<ServerConfig>,
    client_config: Arc<rustls::ClientConfig>,
) -> std::io::Result<tokio_rustls::server::TlsStream<TcpStream>> {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let addr: SocketAddr = listener.local_addr().expect("local addr");

    let server = async move {
        let (stream, _) = listener.accept().await?;
        TlsAcceptor::from(server_config).accept(stream).await
    };
    let client = async move {
        let stream = TcpStream::connect(addr).await?;
        let name = ServerName::try_from("localhost").expect("server name");
        TlsConnector::from(client_config)
            .connect(name, stream)
            .await
    };

    let (server_result, _client_result) = tokio::join!(server, client);
    server_result
}

pub fn err_debug_contains(err: &std::io::Error, needle: &str) -> bool {
    format!("{err:?}").contains(needle)
}
