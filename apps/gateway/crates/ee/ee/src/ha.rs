//! Redis-backed high-availability stores — dropped per plan.md decision 6
//! (single gateway instance is the known ceiling in this fork; Redis is
//! never wired up). The free in-memory `cache::in_memory()` /
//! `approval::in_memory()` stores keep serving every deployment.

/// Startup gate for a configured `REDIS_HOST`. The reason this used to refuse
/// (missing an enterprise license) is gone — entitlement is always on in this
/// fork — but a `REDIS_HOST` still can't be honored (there is no Redis-backed
/// store in this build), so a box configured for HA still needs to fail
/// fast rather than silently run single-instance. That refusal happens one
/// step later, in `redis_cache_store` / `redis_approval_store` below (the
/// composition root calls those when `REDIS_HOST` is set); this function
/// itself always succeeds so it never duplicates that message.
pub fn check_ha_entitlement(_redis_host: Option<&str>, _entitled: bool) -> anyhow::Result<()> {
    Ok(())
}

/// Not available in this build: there is no Redis-backed `CacheStore` here.
/// A deployment with `REDIS_HOST` set should leave it unset instead — the
/// free in-memory store is the only supported cache in this fork.
pub async fn redis_cache_store() -> anyhow::Result<std::sync::Arc<dyn cache::CacheStore>> {
    anyhow::bail!("Redis-backed stores are not available in this build; leave REDIS_HOST unset")
}

/// Not available in this build: there is no Redis-backed `ApprovalStore`
/// here. A deployment with `REDIS_HOST` set should leave it unset instead —
/// the free in-memory store is the only supported approval queue in this
/// fork.
pub async fn redis_approval_store() -> anyhow::Result<std::sync::Arc<dyn approval::ApprovalStore>> {
    anyhow::bail!("Redis-backed stores are not available in this build; leave REDIS_HOST unset")
}
