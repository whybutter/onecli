//! Licensed role-recheck seam (`context::auth::RoleResolver`).
//!
//! Phase 0 posture (`docs/upstream-sync/v2-migration/phase0-plan.md`
//! Executive Summary #2, Risk 4): `Ok(true)` for both methods is not a lazy
//! stub — it is provably equivalent to today's behavior. See
//! `crates/context/src/auth.rs` (`user_is_org_admin` recheck around line 450,
//! `user_can_manage_workspace` recheck around line 552): when no resolver is
//! installed (`ROLE_RESOLVER.get()` is `None` — the unlicensed-onprem default
//! this fork inherited), the role-recheck layer stands down entirely and the
//! request is treated as allowed. An installed resolver that always answers
//! `Ok(true)` produces the exact same outcome, byte-for-byte. LIVENESS checks
//! (`db::user_is_active_org_member`, `db::user_can_access_workspace`) are
//! unconditional in `context::auth` either way and are NOT bypassed by this.
//!
//! Phase 1 replaces this with the real `organization_members` /
//! `workspace_access` (+ group) queries described in
//! `docs/upstream-sync/v2-migration/gateway-ee-behaviour.md` §3.

pub struct RbacRoleResolver;

#[async_trait::async_trait]
impl context::auth::RoleResolver for RbacRoleResolver {
    async fn user_is_org_admin(
        &self,
        _pool: &sqlx::PgPool,
        _user_id: &str,
        _organization_id: &str,
    ) -> anyhow::Result<bool> {
        Ok(true)
    }

    async fn user_can_manage_workspace(
        &self,
        _pool: &sqlx::PgPool,
        _user_id: &str,
        _workspace_id: &str,
    ) -> anyhow::Result<bool> {
        Ok(true)
    }
}
