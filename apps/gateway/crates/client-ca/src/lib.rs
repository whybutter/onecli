//! mTLS client-certificate support: identity extraction from a verified
//! client certificate chain, TLS server config / trust anchor assembly, and
//! the CA that mints short-lived client certificates from a CSR.
//!
//! The gateway can *require* a client certificate on a dedicated port
//! ([`mtls::MtlsConfig`]) and *extract* an identity from it
//! ([`ClientIdentity`] / [`identity_from_peer_certs`]); minting comes from
//! [`ClientCa::sign_csr`]. This crate never enforces anything on its own — it
//! is threaded onto the caller's context and compared/logged there (see
//! `server::mtls` and, later, cert↔token binding enforcement).
//!
//! mTLS is entirely opt-in: unset `GATEWAY_MTLS_PORT` and this crate's
//! `MtlsConfig::from_env` returns `Ok(None)` — the gateway runs exactly as it
//! did before this crate existed.

pub mod authority;
pub mod identity;
pub mod mtls;
// `pub`, not gated at all, would ship the loopback-handshake harness inside
// every production binary that depends on this crate. `cfg(test)` covers
// this crate's own `cargo test -p client-ca`; the `test-support` feature
// covers `relay`/`server`, whose test binaries dev-depend on this crate with
// the feature enabled (see this crate's Cargo.toml) to reuse the same
// harness rather than duplicating it.
#[cfg(any(test, feature = "test-support"))]
pub mod test_support;

pub use authority::{ClientCa, IssuedCert, SignCsrError};
pub use identity::{identity_from_peer_certs, ClientIdentity};
pub use mtls::{load_client_ca_roots, load_root_store, pem_from_value, MtlsConfig};
