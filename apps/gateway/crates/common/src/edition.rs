//! Runtime edition identity for the gateway.
//!
//! One binary serves both editions; the `EDITION` env var selects at startup:
//! `cloud` → Cloud, anything else or unset → Onprem (the self-hosted default —
//! the legacy `oss` value also lands here). Read once into a `OnceLock` so the
//! value cannot change mid-process, the same pattern as the auth secret
//! (`auth.rs`). Code with an edition branch should take `Edition` as a
//! parameter (table-testable) and read `edition()` only at the call site.

use std::sync::OnceLock;

/// The distribution edition this process is running as.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Edition {
    /// Self-hosted (the default for any `EDITION` value other than `cloud`).
    Onprem,
    Cloud,
}

fn parse(raw: Option<&str>) -> Edition {
    match raw.map(str::trim) {
        Some(v) if v.eq_ignore_ascii_case("cloud") => Edition::Cloud,
        _ => Edition::Onprem,
    }
}

/// The edition selected by the `EDITION` env var, read once at first use.
pub fn edition() -> Edition {
    static EDITION: OnceLock<Edition> = OnceLock::new();
    *EDITION.get_or_init(|| parse(std::env::var("EDITION").ok().as_deref()))
}

/// Whether this deployment may run enterprise features.
///
/// This fork has no `ENTERPRISE_ENABLED` switch and no unlicensed lane: every
/// deployment — cloud or onprem — is always entitled
/// (`docs/upstream-sync/v2-migration/plan.md` Principle 3, "Always
/// entitled"). Kept as a function (not inlined at call sites) so the
/// entitlement gates scattered through the free crates (`proxy::connect`,
/// `policy-engine::enforce`, `wiring.rs`, …) need no further changes — they
/// still read `entitled()` and get a constant `true`.
pub fn entitled() -> bool {
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cloud_parses_case_insensitively_and_trimmed() {
        assert_eq!(parse(Some("cloud")), Edition::Cloud);
        assert_eq!(parse(Some("  CLOUD ")), Edition::Cloud);
    }

    #[test]
    fn everything_else_is_onprem() {
        assert_eq!(parse(None), Edition::Onprem);
        assert_eq!(parse(Some("")), Edition::Onprem);
        assert_eq!(parse(Some("oss")), Edition::Onprem); // legacy value
        assert_eq!(parse(Some("garbage")), Edition::Onprem);
    }

    #[test]
    fn always_entitled() {
        // No `ENTERPRISE_ENABLED` switch in this fork — every deployment is
        // entitled, regardless of edition or environment.
        assert!(entitled());
    }
}
