//! Identity extraction from a client certificate that already passed the TLS
//! verifier's chain-of-trust and expiry checks.
//!
//! This module only extracts and reports — it never compares the identity to
//! anything. Enforcement (comparing [`ClientIdentity`] against an agent
//! token, cert↔token tenant binding, ...) lives in the caller.

use rustls::pki_types::CertificateDer;

/// Identity extracted from a verified client certificate.
///
/// [`Self::primary`] is the field callers compare against/log — the first
/// URI SAN if present (agents are expected to mint `spiffe://`-style URIs),
/// else the Common Name.
#[derive(Debug, Clone, PartialEq)]
pub struct ClientIdentity {
    pub cn: Option<String>,
    pub uri_sans: Vec<String>,
    pub serial_hex: String,
    pub not_after_unix: i64,
}

impl ClientIdentity {
    /// The identity used for logging and matching: the first URI SAN if
    /// present, else the Common Name.
    pub fn primary(&self) -> Option<&str> {
        self.uri_sans
            .first()
            .map(String::as_str)
            .or(self.cn.as_deref())
    }
}

impl std::fmt::Display for ClientIdentity {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.primary().unwrap_or("unknown"))
    }
}

/// Extract a [`ClientIdentity`] from the peer certificate chain presented
/// during the TLS handshake. `certs[0]` is the end-entity leaf — rustls
/// presents the chain leaf-first — intermediates are ignored.
///
/// Never panics: an empty slice, a leaf that fails to parse, or a hostile CN/
/// SAN (see `sanitize_identity_component`) all just fall through to `None`
/// pieces rather than a panic. The TLS verifier has already rejected chains
/// that don't verify by the time this runs, so there's nothing to fail closed
/// on here — this function doesn't enforce, it only reports what it saw.
pub fn identity_from_peer_certs(certs: &[CertificateDer<'_>]) -> Option<ClientIdentity> {
    let leaf = certs.first()?;
    let (_, cert) = x509_parser::parse_x509_certificate(leaf.as_ref()).ok()?;

    let cn = cert
        .subject()
        .iter_common_name()
        .next()
        .and_then(|attr| attr.as_str().ok())
        .and_then(sanitize_identity_component);

    let uri_sans = cert
        .subject_alternative_name()
        .ok()
        .flatten()
        .map(|ext| {
            ext.value
                .general_names
                .iter()
                .filter_map(|name| match name {
                    x509_parser::extensions::GeneralName::URI(uri) => Some(*uri),
                    _ => None,
                })
                .filter_map(sanitize_identity_component)
                .collect()
        })
        .unwrap_or_default();

    let serial_hex = hex::encode(cert.raw_serial());
    let not_after_unix = cert.validity().not_after.timestamp();

    Some(ClientIdentity {
        cn,
        uri_sans,
        serial_hex,
        not_after_unix,
    })
}

/// Validate a single identity component (a CN or a URI SAN) pulled from an
/// otherwise-trusted certificate. The certificate chains to a trust anchor,
/// but its *content* is still attacker-controlled (anyone who can get a cert
/// signed by the configured client CA picks their own CN/SAN) — this becomes
/// a log field and a lookup key, so control characters and oversized values
/// are dropped rather than "cleaned up": a component that fails validation
/// contributes nothing rather than a mangled value.
fn sanitize_identity_component(s: &str) -> Option<String> {
    if s.is_empty() || s.len() > 253 {
        return None;
    }
    // Printable ASCII only — this also excludes '\n'/'\r' (0x0A/0x0D), which
    // fall outside 0x20..=0x7E; '"' and '\\' are inside that range and need
    // an explicit check.
    if !s.chars().all(|c| matches!(c, '\u{20}'..='\u{7E}')) {
        return None;
    }
    if s.contains('"') || s.contains('\\') {
        return None;
    }
    Some(s.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── sanitize_identity_component ─────────────────────────────────────

    #[test]
    fn sanitize_accepts_plain_values() {
        assert_eq!(
            sanitize_identity_component("agent-42"),
            Some("agent-42".to_string())
        );
        assert_eq!(
            sanitize_identity_component("spiffe://onecli/agent/42"),
            Some("spiffe://onecli/agent/42".to_string())
        );
    }

    #[test]
    fn sanitize_drops_empty() {
        assert_eq!(sanitize_identity_component(""), None);
    }

    #[test]
    fn sanitize_drops_oversized() {
        let long = "a".repeat(254);
        assert_eq!(sanitize_identity_component(&long), None);
        // 253 bytes is the boundary — still accepted.
        let boundary = "a".repeat(253);
        assert!(sanitize_identity_component(&boundary).is_some());
    }

    #[test]
    fn sanitize_drops_newline_and_cr() {
        assert_eq!(sanitize_identity_component("agent\n42"), None);
        assert_eq!(sanitize_identity_component("agent\r42"), None);
    }

    #[test]
    fn sanitize_drops_quote_and_backslash() {
        assert_eq!(sanitize_identity_component("agent\"42"), None);
        assert_eq!(sanitize_identity_component("agent\\42"), None);
    }

    #[test]
    fn sanitize_drops_non_ascii() {
        assert_eq!(sanitize_identity_component("agenté"), None);
    }

    // ── ClientIdentity::primary ──────────────────────────────────────────

    #[test]
    fn primary_prefers_uri_san_over_cn() {
        let id = ClientIdentity {
            cn: Some("fallback-cn".to_string()),
            uri_sans: vec!["spiffe://onecli/agent/1".to_string()],
            serial_hex: "ab".to_string(),
            not_after_unix: 0,
        };
        assert_eq!(id.primary(), Some("spiffe://onecli/agent/1"));
    }

    #[test]
    fn primary_falls_back_to_cn() {
        let id = ClientIdentity {
            cn: Some("cn-only".to_string()),
            uri_sans: vec![],
            serial_hex: "ab".to_string(),
            not_after_unix: 0,
        };
        assert_eq!(id.primary(), Some("cn-only"));
    }

    #[test]
    fn primary_none_when_both_missing() {
        let id = ClientIdentity {
            cn: None,
            uri_sans: vec![],
            serial_hex: "ab".to_string(),
            not_after_unix: 0,
        };
        assert_eq!(id.primary(), None);
    }

    #[test]
    fn display_uses_primary() {
        let id = ClientIdentity {
            cn: Some("cn-only".to_string()),
            uri_sans: vec![],
            serial_hex: "ab".to_string(),
            not_after_unix: 0,
        };
        assert_eq!(id.to_string(), "cn-only");
    }

    // ── identity_from_peer_certs: empty/malformed input never panics ────

    #[test]
    fn identity_from_empty_slice_is_none() {
        assert_eq!(identity_from_peer_certs(&[]), None);
    }

    #[test]
    fn identity_from_garbage_der_is_none() {
        let garbage = CertificateDer::from(vec![0u8, 1, 2, 3, 4]);
        assert_eq!(
            identity_from_peer_certs(std::slice::from_ref(&garbage)),
            None
        );
    }
}
