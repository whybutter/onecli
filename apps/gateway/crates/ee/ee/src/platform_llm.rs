//! Platform-provided Anthropic trial credit — a Cloud-only feature (the
//! licensed original gates the whole module on `Edition::Cloud`), permanently
//! dropped in this onprem-only fork. Every function here is a pure DROP
//! stand-in: `configured_for_host`/`pool_has_llm_credential` return `false`,
//! `platform_credential` returns `None`, so `proxy::connect` never injects a
//! platform key and never synthesizes a platform budget binding.

/// Read by `ee::response::budget_exceeded` to distinguish the (unreachable in
/// this build) trial-credit arm from an ordinary org budget. Kept as a
/// constant rather than deleted so that call site needs no change.
pub const PLATFORM_SECRET_ID: &str = "platform:anthropic";

/// Never configured: this fork has no platform Anthropic key.
#[must_use]
pub fn configured_for_host(_hostname: &str) -> bool {
    false
}

/// Moot once `configured_for_host` is always false, but kept real-shaped
/// (`proxy::connect` calls it unconditionally once the cheap host check
/// passes) — the platform-candidate branch above already short-circuits it.
#[must_use]
pub fn pool_has_llm_credential(_secrets: &[db::SecretRow]) -> bool {
    false
}

/// Always `None`: the platform trial-credit feature is Cloud-only and this
/// fork never sets `EDITION=cloud`.
pub async fn platform_credential(
    _pool: &sqlx::PgPool,
    _org_id: &str,
    _hostname: &str,
    _pool_has_llm: bool,
    _entitled: bool,
) -> Option<(inject::InjectionRule, crate::budget::BudgetBinding)> {
    None
}
