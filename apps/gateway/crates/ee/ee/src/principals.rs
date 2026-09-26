//! Connect-time principal resolution: who (beyond the agent itself) a
//! workspace's published v2 rules may name by identity, and — separately —
//! which app providers a workspace's org restricts.
//!
//! Phase 0 posture (`docs/upstream-sync/v2-migration/phase0-plan.md` WP2,
//! Risk 2; `gateway-ee-behaviour.md` §2.3): `find_principal_set` is
//! security-critical and ships DIRECT USERS ONLY — the exact same shape as
//! the free `policy_engine::find_direct_user_principals` twin that runs when
//! unentitled, just re-implemented here (not called) so `ee` never takes a
//! production dependency on `policy-engine` (that would be a dependency
//! cycle: `policy-engine` depends on `ee`). Group-based inheritance is a
//! Phase 1 KEEP item, deliberately not built yet — returning an EMPTY
//! `PrincipalSet` here would be a real regression (it would silently drop
//! every direct-user grant that works today), so this function must not be
//! "simplified" to a stub.
//!
//! App availability is TRIMMED per plan.md ("loader can return unrestricted
//! until the admin page ships"): `load_available_apps` always returns the
//! unrestricted default. `app_availability_block` stays a real, pure
//! function so Phase 2/3 only has to flip the loader, not touch this.

/// Direct-only mirror of the free `find_direct_user_principals` twin
/// (`policy-engine/src/loaders.rs`): DISTINCT `workspace_access.user_id` for
/// the workspace, org-fenced and filtered to active (non-suspended) members.
/// Group membership (`workspace_access.group_id`, `group_members`) is not
/// resolved yet — `group_ids` is always empty, matching today's unentitled
/// behavior exactly (see module doc).
///
/// Any DB error propagates: the caller (`policy_engine::load_connect_v2`)
/// refuses the whole CONNECT resolution rather than caching an
/// under-resolved (and therefore over-permissive) principal set.
pub async fn find_principal_set(
    pool: &sqlx::PgPool,
    workspace_id: &str,
    organization_id: &str,
) -> anyhow::Result<db::PrincipalSet> {
    let rows: Vec<(String,)> = sqlx::query_as(
        // Kept in lockstep with the free twin's query (see module doc):
        // same org fence (the membership join), same liveness predicate
        // (`status <> 'suspended'`, NOT `= 'active'`).
        r#"SELECT DISTINCT wa.user_id
           FROM workspace_access wa
           JOIN organization_members om
             ON om.user_id = wa.user_id
            AND om.organization_id = $2
            AND om.status <> 'suspended'
           WHERE wa.workspace_id = $1
             AND wa.user_id IS NOT NULL"#,
    )
    .bind(workspace_id)
    .bind(organization_id)
    .fetch_all(pool)
    .await?;

    Ok(db::PrincipalSet {
        user_ids: rows.into_iter().map(|(id,)| id).collect(),
        group_ids: Vec::new(),
    })
}

/// Always unrestricted in this build (TRIM per plan.md): no admin surface
/// exists yet to author `app_availability_rules`, so every workspace behaves
/// as `app_availability_mode = "open"`. Infallible by signature (the licensed
/// original also fails open on any DB error), so there is nothing to fail
/// here either.
pub async fn load_available_apps(
    _pool: &sqlx::PgPool,
    _org_id: &str,
    _workspace_id: &str,
) -> db::AvailableApps {
    db::AvailableApps::default()
}

/// Per-request, DB-free block check. Kept real (pure, cheap) per plan.md so
/// flipping `load_available_apps` to a real loader later needs no change
/// here. With `load_available_apps` always returning `restricted: false`
/// this is always `None` today.
#[must_use]
pub fn app_availability_block(
    host: &str,
    path: &str,
    available: &db::AvailableApps,
) -> Option<String> {
    if !available.restricted {
        return None;
    }
    let host = common::util::strip_port(host).to_lowercase();
    let (provider, _display_name) = apps::provider_for_host_and_path(&host, path)?;
    (!available.providers.iter().any(|p| p == provider)).then(|| provider.to_string())
}
