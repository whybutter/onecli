//! Cert-identity ↔ agent-token tenant binding enforcement — the DB/cache
//! integration glue around the pure [`binding::evaluate`] decision core.
//!
//! [`enforce_binding`] is the ONE function both `handle_connect` and
//! `handle_http_proxy` call (right after `connect::resolve` succeeds, before
//! any vault-fallback/MITM spawn), so the two proxy entry points can never
//! diverge on what "permitted" means — the whole point of this feature.

use std::sync::Arc;

use hyper::Response;
use tracing::warn;

use binding::{BindingDecision, BindingMode};
use client_ca::ClientIdentity;
use context::GatewayState;

/// Cache TTL for host-tenant lookups — the same 60s window `connect::resolve`
/// uses for `ConnectResponse`, so a revoked/renamed `client_hosts` row is
/// picked up on the same staleness budget as everything else CONNECT-time
/// resolution already accepts.
const BINDING_CACHE_TTL_SECS: u64 = 60;

/// Resolve the `client_hosts` row for `spiffe` via the cache, falling back to
/// `db::find_client_host_by_spiffe` on a miss — mirroring `connect::resolve`'s
/// cache-then-DB pattern. Negative results (no matching row) are cached too,
/// exactly like a positive one: `Option<db::ClientHostRow>` round-trips
/// through the cache either way, so an attacker hammering an unknown spiffe
/// URI doesn't turn into a sustained DB query per request.
///
/// Returns `Err(())` — collapsing whatever the underlying error was — when
/// the lookup itself failed (DB or cache-deserialization trouble); the caller
/// ([`enforce_binding`]) fails closed on that, and `binding::evaluate` never
/// needs to know anything about the failure beyond "it happened".
pub(crate) async fn resolve_host_tenant(
    state: &GatewayState,
    spiffe: &str,
) -> Result<Option<db::ClientHostRow>, ()> {
    let cache_key = format!("binding:host:{spiffe}");

    if let Some(cached) = state
        .cache
        .get::<Option<db::ClientHostRow>>(&cache_key)
        .await
    {
        return Ok(cached);
    }

    match db::find_client_host_by_spiffe(&state.policy_engine.pool, spiffe).await {
        Ok(row) => {
            state
                .cache
                .set(&cache_key, &row, BINDING_CACHE_TTL_SECS)
                .await;
            Ok(row)
        }
        Err(e) => {
            warn!(spiffe = %spiffe, error = ?e, "binding: client_hosts lookup failed");
            Err(())
        }
    }
}

/// Enforcement gate — the ONE place `handle_connect` and `handle_http_proxy`
/// both call into, so the two entry points can never diverge on what
/// "permitted" means. Returns `Some(response)` to short-circuit the request
/// with a denial, `None` to let it proceed.
///
/// `mode == Off` or `!on_mtls` (the plain listener is exempt BY LISTENER
/// KIND, in every mode — see `binding`'s module doc) both return `None`
/// WITHOUT ever resolving the host tenant: zero DB/cache overhead beyond the
/// mode/on_mtls check itself, so a default (unset) deployment pays nothing
/// for this feature's existence.
pub(crate) async fn enforce_binding(
    state: &GatewayState,
    on_mtls: bool,
    client_identity: Option<&Arc<ClientIdentity>>,
    agent_id: Option<&str>,
    token_workspace: &str,
    token_org: Option<&str>,
) -> Option<Response<axum::body::Body>> {
    if matches!(state.binding_mode, BindingMode::Off) || !on_mtls {
        return None;
    }

    let identity = client_identity.and_then(|id| id.primary());

    // Only resolve the host tenant when there's an identity to look up at
    // all — `binding::evaluate` denies a missing identity before it ever
    // looks at this result, so an unparseable-cert request never touches the
    // cache or DB.
    let host_lookup: Option<Result<Option<db::ClientHostRow>, ()>> = match identity {
        Some(spiffe) => Some(resolve_host_tenant(state, spiffe).await),
        None => None,
    };
    let host_tenant: Result<Option<&db::ClientHostRow>, ()> = match &host_lookup {
        Some(Ok(row)) => Ok(row.as_ref()),
        Some(Err(())) => Err(()),
        None => Ok(None),
    };
    let host_workspace_id = match &host_lookup {
        Some(Ok(Some(row))) => Some(row.workspace_id.as_str()),
        _ => None,
    };

    let decision = binding::evaluate(
        state.binding_mode,
        on_mtls,
        identity,
        host_tenant,
        token_workspace,
        token_org,
    );

    match decision {
        BindingDecision::Allow => None,
        BindingDecision::WouldDeny { reason } => {
            // Log-mode audit trail: this is what `Enforce` WOULD have denied.
            // Never logs the token or any secret — spiffe/host/token ids only.
            warn!(
                spiffe = identity.unwrap_or("-"),
                host_workspace_id = host_workspace_id.unwrap_or("-"),
                token_workspace_id = %token_workspace,
                token_org_id = token_org.unwrap_or("-"),
                agent_id = agent_id.unwrap_or("-"),
                reason,
                mode = ?state.binding_mode,
                on_mtls,
                decision = "would_deny",
                "binding: cert/token tenant mismatch (log mode — request allowed)"
            );
            None
        }
        BindingDecision::Deny { reason } => {
            warn!(
                spiffe = identity.unwrap_or("-"),
                host_workspace_id = host_workspace_id.unwrap_or("-"),
                token_workspace_id = %token_workspace,
                token_org_id = token_org.unwrap_or("-"),
                agent_id = agent_id.unwrap_or("-"),
                reason,
                mode = ?state.binding_mode,
                on_mtls,
                decision = "deny",
                "binding: cert/token tenant mismatch — request denied"
            );
            // The lookup-failed case is retryable (a transient DB/cache
            // hiccup, not a permanent verdict about this identity) — 502,
            // same as every other internal-error path in this crate. Every
            // other reason (mismatch, unknown/revoked host, missing
            // identity) is a permanent denial — 403.
            if reason == binding::REASON_HOST_LOOKUP_ERROR {
                Some(proxy::response::bad_gateway())
            } else {
                Some(proxy::response::binding_denied())
            }
        }
    }
}

// ── Tests ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use hyper::StatusCode;

    /// `ClientConfig::builder()` panics when no process-default provider is
    /// installed, and both `ring` and `aws-lc-rs` are compiled in, so rustls
    /// cannot pick one on its own — mirrors `crate::tests::ensure_crypto_provider`.
    fn ensure_crypto_provider() {
        static INIT_CRYPTO: std::sync::Once = std::sync::Once::new();
        INIT_CRYPTO.call_once(|| {
            let _ = rustls::crypto::ring::default_provider().install_default();
        });
    }

    /// A minimal `GatewayState` for these tests. The pool is a `connect_lazy`
    /// handle to a `PolicyEngine::test_stub()` — nothing listens there — so
    /// this is USED deliberately below, not merely tolerated:
    ///   - Cache-seeded scenarios never touch the DB at all (a cache hit
    ///     returns before `db::find_client_host_by_spiffe` is ever called),
    ///     so they exercise real code, not a stub.
    ///   - The one scenario that must reach the DB (`enforce_binding` with
    ///     nothing cached) gets a real `Err` from the doomed connection
    ///     attempt — which IS the fail-closed path this suite needs to prove.
    async fn test_gateway_state() -> GatewayState {
        ensure_crypto_provider();
        let tmp = tempfile::tempdir().expect("tempdir");
        let ca = ca::CertificateAuthority::load_or_generate(tmp.path())
            .await
            .expect("test ca");
        let policy_engine = std::sync::Arc::new(context::PolicyEngine::test_stub());
        let vault_service =
            std::sync::Arc::new(vault::VaultService::new(vec![], policy_engine.pool.clone()));

        GatewayState {
            ca: std::sync::Arc::new(ca),
            http_client: reqwest::Client::builder().build().expect("http client"),
            http_client_no_verify: reqwest::Client::builder().build().expect("http client"),
            skip_verify_hosts: std::sync::Arc::new(vec![]),
            ws_connector: tokio_rustls::TlsConnector::from(std::sync::Arc::new(
                rustls::ClientConfig::builder()
                    .with_root_certificates(rustls::RootCertStore::empty())
                    .with_no_client_auth(),
            )),
            ws_connector_no_verify: tokio_rustls::TlsConnector::from(std::sync::Arc::new(
                rustls::ClientConfig::builder()
                    .with_root_certificates(rustls::RootCertStore::empty())
                    .with_no_client_auth(),
            )),
            policy_engine,
            cache: cache::in_memory(),
            vault_service,
            approval_store: approval::in_memory(),
            client_ca: None,
            binding_mode: BindingMode::Off,
        }
    }

    fn binding_test_identity(spiffe: &str) -> Arc<ClientIdentity> {
        Arc::new(ClientIdentity {
            cn: None,
            uri_sans: vec![spiffe.to_string()],
            serial_hex: "ab".to_string(),
            not_after_unix: 0,
        })
    }

    /// A cert whose CN/SAN failed extraction (or was never sanitizable) —
    /// `ClientIdentity::primary()` returns `None`. Distinct from "no cert at
    /// all" (`on_mtls = false`): this identity came from a verified mTLS
    /// handshake, so `on_mtls = true` in every test that uses it.
    fn binding_test_unparseable_identity() -> Arc<ClientIdentity> {
        Arc::new(ClientIdentity {
            cn: None,
            uri_sans: vec![],
            serial_hex: "ab".to_string(),
            not_after_unix: 0,
        })
    }

    /// `revoked_at` is `TIMESTAMP` (no time zone — see `db::ClientHostRow`'s
    /// doc comment), so the stand-in "now" value must be a
    /// `PrimitiveDateTime`, not an `OffsetDateTime`.
    fn binding_test_host_row(
        workspace_id: &str,
        organization_id: Option<&str>,
        revoked: bool,
    ) -> db::ClientHostRow {
        let now = time::OffsetDateTime::now_utc();
        db::ClientHostRow {
            workspace_id: workspace_id.to_string(),
            organization_id: organization_id.map(str::to_string),
            revoked_at: revoked.then(|| time::PrimitiveDateTime::new(now.date(), now.time())),
        }
    }

    async fn seed_binding_cache(
        state: &GatewayState,
        spiffe: &str,
        row: Option<&db::ClientHostRow>,
    ) {
        state
            .cache
            .set(
                &format!("binding:host:{spiffe}"),
                &row,
                BINDING_CACHE_TTL_SECS,
            )
            .await;
    }

    async fn binding_state(mode: BindingMode) -> GatewayState {
        let mut state = test_gateway_state().await;
        state.binding_mode = mode;
        state
    }

    #[tokio::test]
    async fn enforce_binding_off_mode_allows_without_ever_resolving_the_host() {
        let state = binding_state(BindingMode::Off).await;
        // Deliberately unseeded: if `Off` resolved the host tenant anyway, it
        // would hit the dead test DB and this test would hang/slow down
        // rather than return immediately.
        let id = binding_test_identity("spiffe://onecli/host/off-1");
        let result = enforce_binding(
            &state,
            true,
            Some(&id),
            Some("agent-1"),
            "workspace-A",
            None,
        )
        .await;
        assert!(result.is_none(), "Off must allow unconditionally");
    }

    #[tokio::test]
    async fn enforce_binding_plain_listener_exempt_even_under_enforce() {
        let state = binding_state(BindingMode::Enforce).await;
        let id = binding_test_identity("spiffe://onecli/host/plain-1");
        // on_mtls = false: must be exempt regardless of mode, unseeded cache,
        // or anything else — the plain listener never had a cert to bind.
        let result = enforce_binding(
            &state,
            false,
            Some(&id),
            Some("agent-1"),
            "workspace-A",
            None,
        )
        .await;
        assert!(
            result.is_none(),
            "plain-listener requests are always exempt"
        );
    }

    #[tokio::test]
    async fn enforce_binding_matching_tenant_allows_under_enforce() {
        let state = binding_state(BindingMode::Enforce).await;
        let spiffe = "spiffe://onecli/host/match-1";
        seed_binding_cache(
            &state,
            spiffe,
            Some(&binding_test_host_row("workspace-A", Some("org-1"), false)),
        )
        .await;
        let id = binding_test_identity(spiffe);
        let result = enforce_binding(
            &state,
            true,
            Some(&id),
            Some("agent-1"),
            "workspace-A",
            Some("org-1"),
        )
        .await;
        assert!(result.is_none());
    }

    #[tokio::test]
    async fn enforce_binding_mismatched_tenant_403s_under_enforce() {
        let state = binding_state(BindingMode::Enforce).await;
        let spiffe = "spiffe://onecli/host/mismatch-1";
        seed_binding_cache(
            &state,
            spiffe,
            Some(&binding_test_host_row("workspace-B", None, false)),
        )
        .await;
        let id = binding_test_identity(spiffe);
        let result = enforce_binding(
            &state,
            true,
            Some(&id),
            Some("agent-1"),
            "workspace-A",
            None,
        )
        .await
        .expect("mismatched tenant must be denied under Enforce");
        assert_eq!(result.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn enforce_binding_mismatched_tenant_allowed_under_log_would_deny_only() {
        let state = binding_state(BindingMode::Log).await;
        let spiffe = "spiffe://onecli/host/mismatch-2";
        seed_binding_cache(
            &state,
            spiffe,
            Some(&binding_test_host_row("workspace-B", None, false)),
        )
        .await;
        let id = binding_test_identity(spiffe);
        let result = enforce_binding(
            &state,
            true,
            Some(&id),
            Some("agent-1"),
            "workspace-A",
            None,
        )
        .await;
        assert!(
            result.is_none(),
            "Log mode must allow (WouldDeny), never actually deny"
        );
    }

    #[tokio::test]
    async fn enforce_binding_off_mode_allows_even_a_cached_mismatch() {
        let state = binding_state(BindingMode::Off).await;
        let spiffe = "spiffe://onecli/host/off-2";
        seed_binding_cache(
            &state,
            spiffe,
            Some(&binding_test_host_row("workspace-B", None, false)),
        )
        .await;
        let id = binding_test_identity(spiffe);
        let result = enforce_binding(
            &state,
            true,
            Some(&id),
            Some("agent-1"),
            "workspace-A",
            None,
        )
        .await;
        assert!(result.is_none());
    }

    #[tokio::test]
    async fn enforce_binding_revoked_host_403s_under_enforce() {
        let state = binding_state(BindingMode::Enforce).await;
        let spiffe = "spiffe://onecli/host/revoked-1";
        seed_binding_cache(
            &state,
            spiffe,
            Some(&binding_test_host_row("workspace-A", None, true)),
        )
        .await;
        let id = binding_test_identity(spiffe);
        let result = enforce_binding(
            &state,
            true,
            Some(&id),
            Some("agent-1"),
            "workspace-A",
            None,
        )
        .await
        .expect("revoked host must be denied even with a matching workspace");
        assert_eq!(result.status(), StatusCode::FORBIDDEN);
    }

    /// Subtlety #1: an mTLS handshake with no extractable identity must be
    /// DENIED, not treated as an exempt plain-listener request.
    #[tokio::test]
    async fn enforce_binding_unparseable_identity_403s_under_enforce_not_exempt() {
        let state = binding_state(BindingMode::Enforce).await;
        let id = binding_test_unparseable_identity();
        let result = enforce_binding(
            &state,
            true,
            Some(&id),
            Some("agent-1"),
            "workspace-A",
            None,
        )
        .await
        .expect("a verified mTLS cert with no usable identity must be denied");
        assert_eq!(result.status(), StatusCode::FORBIDDEN);
    }

    /// Fail-closed on a lookup failure must be 502 (retryable), never 403
    /// (permanent) — a transient DB/cache outage is not a verdict about this
    /// identity. Unseeded cache + the dead test-DB pool together give a real
    /// lookup failure here, not a simulated one.
    #[tokio::test]
    async fn enforce_binding_db_error_502s_under_enforce_not_403() {
        let state = binding_state(BindingMode::Enforce).await;
        let id = binding_test_identity("spiffe://onecli/host/db-error-1");
        let result = enforce_binding(
            &state,
            true,
            Some(&id),
            Some("agent-1"),
            "workspace-A",
            None,
        )
        .await
        .expect("a lookup failure must fail closed (deny), not silently allow");
        assert_eq!(
            result.status(),
            StatusCode::BAD_GATEWAY,
            "a lookup failure is retryable — 502, not a permanent 403"
        );
    }

    #[tokio::test]
    async fn resolve_host_tenant_serves_a_cached_negative_result_without_touching_the_db() {
        let state = test_gateway_state().await;
        let spiffe = "spiffe://onecli/host/neg-1";
        // Cache an explicit "no such host" — proves negative results ride
        // the same `Option<db::ClientHostRow>` cache slot a positive one
        // would, and that a hit (positive OR negative) never reaches the DB.
        seed_binding_cache(&state, spiffe, None).await;
        let result = resolve_host_tenant(&state, spiffe).await;
        assert_eq!(result, Ok(None));
    }
}
