//! Licensed role-recheck seam (`context::auth::RoleResolver`).
//!
//! Phase 1 (`docs/upstream-sync/v2-migration/phase1-plan.md` WP-A;
//! `gateway-ee-behaviour.md` §3): real `organization_members` /
//! `workspace_access` (+ group) queries, replacing the Phase 0
//! `Ok(true)`-for-everything stub. Runs on EVERY `oc_` bearer request (no
//! caching — Risk 1: caching the recheck would reopen the demotion/unshare
//! lag it exists to close). `created_by_user_id` on workspaces is pure
//! provenance and is never consulted. A DB error is `Err`, which the auth
//! layer maps to the same uniform 401 as every other failure.

use anyhow::Context;

pub struct RbacRoleResolver;

#[async_trait::async_trait]
impl context::auth::RoleResolver for RbacRoleResolver {
    async fn user_is_org_admin(
        &self,
        pool: &sqlx::PgPool,
        user_id: &str,
        organization_id: &str,
    ) -> anyhow::Result<bool> {
        user_is_org_admin(pool, user_id, organization_id).await
    }

    async fn user_can_manage_workspace(
        &self,
        pool: &sqlx::PgPool,
        user_id: &str,
        workspace_id: &str,
    ) -> anyhow::Result<bool> {
        user_can_manage_workspace(pool, user_id, workspace_id).await
    }
}

/// `oc_org_*` role recheck: one row in `organization_members` with
/// `user_id`, `organization_id`, `status <> 'suspended'`,
/// `role IN ('owner', 'admin')`. No caching.
pub async fn user_is_org_admin(
    pool: &sqlx::PgPool,
    user_id: &str,
    organization_id: &str,
) -> anyhow::Result<bool> {
    let row: Option<(String,)> = sqlx::query_as(
        r#"SELECT user_id
           FROM organization_members
           WHERE user_id = $1 AND organization_id = $2
             AND status <> 'suspended'
             AND role IN ('owner', 'admin')
           LIMIT 1"#,
    )
    .bind(user_id)
    .bind(organization_id)
    .fetch_optional(pool)
    .await
    .context("checking org admin/owner role")?;
    Ok(row.is_some())
}

/// `oc_*` (workspace) role recheck: active membership in the workspace's org
/// (joining `workspaces` to `organization_members` on org id,
/// `status <> 'suspended'`), then any of: org role owner/admin; a
/// `workspace_access` row for this workspace with `user_id`; a
/// `workspace_access` row for this workspace with a `group_id` the user
/// belongs to via `group_members`, the group itself fenced to the
/// workspace's org (mirrors `principals::find_principal_set`'s
/// `direct_groups` fence — without it, a `workspace_access` row binding a
/// cross-org group would grant management here while the principal CTE
/// excludes that same row). `workspace_access.role` is never consulted here
/// — usage is role-blind, unlike the management-role checks the web app
/// runs. One query; no caching.
pub async fn user_can_manage_workspace(
    pool: &sqlx::PgPool,
    user_id: &str,
    workspace_id: &str,
) -> anyhow::Result<bool> {
    let row: Option<(bool,)> = sqlx::query_as(
        r#"SELECT (
               om.role IN ('owner', 'admin')
               OR EXISTS (
                 SELECT 1 FROM workspace_access wa
                 WHERE wa.workspace_id = $2 AND wa.user_id = $1
               )
               OR EXISTS (
                 SELECT 1
                 FROM workspace_access wa
                 JOIN groups g ON g.id = wa.group_id AND g.organization_id = w.organization_id
                 JOIN group_members gm ON gm.group_id = wa.group_id
                 WHERE wa.workspace_id = $2 AND gm.user_id = $1
               )
           )
           FROM workspaces w
           JOIN organization_members om
             ON om.organization_id = w.organization_id
            AND om.user_id = $1
            AND om.status <> 'suspended'
           WHERE w.id = $2"#,
    )
    .bind(user_id)
    .bind(workspace_id)
    .fetch_optional(pool)
    .await
    .context("checking workspace management access")?;
    Ok(row.is_some_and(|(can_manage,)| can_manage))
}

#[cfg(test)]
mod pg_test;
