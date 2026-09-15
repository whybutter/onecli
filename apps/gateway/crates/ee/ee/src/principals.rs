//! Connect-time principal resolution: who (beyond the agent itself) a
//! workspace's published v2 rules may name by identity, and — separately —
//! which app providers a workspace's org restricts.
//!
//! Phase 1 (`docs/upstream-sync/v2-migration/phase1-plan.md` WP-A;
//! `gateway-ee-behaviour.md` §2.3): `find_principal_set` is now the full
//! four-step CTE — direct workspace grants, group-of-a-direct-grant
//! inheritance, the org fence + liveness filter, and groups of the resolved
//! users — replacing the Phase 0 direct-users-only stub. It stays
//! security-critical: any DB error propagates rather than resolving to an
//! empty (and therefore over-permissive) set.
//!
//! App availability is TRIMMED per plan.md ("loader can return unrestricted
//! until the admin page ships"): `load_available_apps` always returns the
//! unrestricted default. `app_availability_block` stays a real, pure
//! function so Phase 2/3 only has to flip the loader, not touch this.

use anyhow::Context;

/// The licensed principal-set CTE (`gateway-ee-behaviour.md` §2.3), in words:
///
/// 1. `direct_groups`: `workspace_access.group_id` for the workspace, joined
///    to `groups` and fenced to `groups.organization_id = org` (a stray
///    cross-org grant cannot leak in).
/// 2. `candidate_users`: UNION of `workspace_access.user_id` for the
///    workspace, and `group_members.user_id` for every group in
///    `direct_groups`.
/// 3. `all_users`: candidates INNER-JOINed to `organization_members` on user
///    id, `organization_id = org`, `status <> 'suspended'` — the org fence
///    for users (a foreign-org-only membership is dropped even with a direct
///    grant) and the liveness filter (suspended out; no membership row =
///    removed = out). Role is ignored.
/// 4. `all_groups`: UNION of `direct_groups` and every org-fenced group any
///    `all_users` member belongs to via `group_members`.
///
/// Distinct ids. Any DB error propagates: the caller
/// (`policy_engine::load_connect_v2`) refuses the whole CONNECT resolution
/// rather than caching an under-resolved principal set. Parity with the free
/// twin (`policy_engine::find_direct_user_principals`) in a direct-only world
/// is pinned by a DB test alongside this function.
pub async fn find_principal_set(
    pool: &sqlx::PgPool,
    workspace_id: &str,
    organization_id: &str,
) -> anyhow::Result<db::PrincipalSet> {
    let rows: Vec<(String, String)> = sqlx::query_as(
        r#"WITH direct_groups AS (
               SELECT wa.group_id AS id
               FROM workspace_access wa
               JOIN groups g ON g.id = wa.group_id AND g.organization_id = $2
               WHERE wa.workspace_id = $1 AND wa.group_id IS NOT NULL
           ),
           candidate_users AS (
               SELECT wa.user_id AS id
               FROM workspace_access wa
               WHERE wa.workspace_id = $1 AND wa.user_id IS NOT NULL
               UNION
               SELECT gm.user_id AS id
               FROM group_members gm
               JOIN direct_groups dg ON dg.id = gm.group_id
           ),
           all_users AS (
               SELECT DISTINCT cu.id
               FROM candidate_users cu
               JOIN organization_members om
                 ON om.user_id = cu.id
                AND om.organization_id = $2
                AND om.status <> 'suspended'
           ),
           all_groups AS (
               SELECT id FROM direct_groups
               UNION
               SELECT g.id
               FROM group_members gm
               JOIN all_users au ON au.id = gm.user_id
               JOIN groups g ON g.id = gm.group_id AND g.organization_id = $2
           )
           SELECT 'user' AS kind, id FROM all_users
           UNION ALL
           SELECT 'group' AS kind, id FROM all_groups"#,
    )
    .bind(workspace_id)
    .bind(organization_id)
    .fetch_all(pool)
    .await
    .context("resolving licensed principal set")?;

    let mut principals = db::PrincipalSet::default();
    for (kind, id) in rows {
        match kind.as_str() {
            "user" => principals.user_ids.push(id),
            "group" => principals.group_ids.push(id),
            other => {
                tracing::warn!(kind = other, id, "find_principal_set: unknown row kind");
            }
        }
    }
    Ok(principals)
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

#[cfg(test)]
mod pg_test;
