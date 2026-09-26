//! Shared scaffolding for the `ee` crate's real-Postgres DB tests
//! (`rbac::pg_test`, `principals::pg_test`).
//!
//! Gated on `GATEWAY_TEST_DATABASE_URL` exactly like
//! `policy_engine::enforce_pg_test`: skipped locally when unset, but MUST
//! run in CI (fails loudly there instead of silently skipping — a silent
//! skip would let the RBAC/principal regression classes these tests exist
//! for go unguarded). Each test seeds its own rows under a fresh random
//! prefix (see [`test_prefix`]) and tears them down with [`cleanup`], so the
//! suite can run repeatedly, and concurrently with other crates' DB tests,
//! against one shared database.

use sqlx::PgPool;

pub(crate) async fn test_pool() -> Option<PgPool> {
    let Ok(url) = std::env::var("GATEWAY_TEST_DATABASE_URL") else {
        assert!(
            std::env::var("CI").is_err(),
            "GATEWAY_TEST_DATABASE_URL must be set in CI: the ee rbac/principal DB tests must not silently skip"
        );
        eprintln!("skipping: GATEWAY_TEST_DATABASE_URL unset");
        return None;
    };
    Some(
        db::create_pool(&url)
            .await
            .expect("connect to test database"),
    )
}

/// A short, collision-resistant prefix for one test's rows. Every id this
/// suite writes starts with it, which is both the fixture-scoping mechanism
/// and the [`cleanup`] key.
pub(crate) fn test_prefix(case: &str) -> String {
    format!("eetest-{case}-{}", uuid::Uuid::new_v4().simple())
}

// `updated_at` on these tables is `@updatedAt` in Prisma: NOT NULL with no DB
// default (Prisma sets it application-side), so every raw insert here must
// supply it explicitly.

pub(crate) async fn seed_org(pool: &PgPool, id: &str) {
    sqlx::query(
        "INSERT INTO organizations (id, name, slug, updated_at) VALUES ($1, $1, $1, NOW())",
    )
    .bind(id)
    .execute(pool)
    .await
    .expect("seed organizations");
}

pub(crate) async fn seed_workspace(pool: &PgPool, id: &str, org_id: &str) {
    sqlx::query("INSERT INTO workspaces (id, organization_id, updated_at) VALUES ($1, $2, NOW())")
        .bind(id)
        .bind(org_id)
        .execute(pool)
        .await
        .expect("seed workspaces");
}

/// Same as [`seed_workspace`], but with `created_by_user_id` set — for
/// pinning that RBAC never consults it (pure provenance).
pub(crate) async fn seed_workspace_with_creator(
    pool: &PgPool,
    id: &str,
    org_id: &str,
    creator_user_id: &str,
) {
    sqlx::query(
        "INSERT INTO workspaces (id, organization_id, created_by_user_id, updated_at)
         VALUES ($1, $2, $3, NOW())",
    )
    .bind(id)
    .bind(org_id)
    .bind(creator_user_id)
    .execute(pool)
    .await
    .expect("seed workspaces (with creator)");
}

pub(crate) async fn seed_user(pool: &PgPool, id: &str) {
    sqlx::query(
        "INSERT INTO users (id, email, external_auth_id, updated_at)
         VALUES ($1, $1 || '@eetest.invalid', $1, NOW())",
    )
    .bind(id)
    .execute(pool)
    .await
    .expect("seed users");
}

pub(crate) async fn seed_membership(
    pool: &PgPool,
    org_id: &str,
    user_id: &str,
    role: &str,
    status: &str,
) {
    sqlx::query(
        "INSERT INTO organization_members (organization_id, user_id, user_email, role, status)
         VALUES ($1, $2, $2 || '@eetest.invalid', $3, $4)",
    )
    .bind(org_id)
    .bind(user_id)
    .bind(role)
    .bind(status)
    .execute(pool)
    .await
    .expect("seed organization_members");
}

pub(crate) async fn seed_workspace_access_user(
    pool: &PgPool,
    id: &str,
    workspace_id: &str,
    user_id: &str,
    role: &str,
) {
    sqlx::query(
        "INSERT INTO workspace_access (id, workspace_id, user_id, role, updated_at)
         VALUES ($1, $2, $3, $4, NOW())",
    )
    .bind(id)
    .bind(workspace_id)
    .bind(user_id)
    .bind(role)
    .execute(pool)
    .await
    .expect("seed workspace_access (user)");
}

pub(crate) async fn delete_workspace_access(pool: &PgPool, id: &str) {
    sqlx::query("DELETE FROM workspace_access WHERE id = $1")
        .bind(id)
        .execute(pool)
        .await
        .expect("delete workspace_access");
}

pub(crate) async fn seed_workspace_access_group(
    pool: &PgPool,
    id: &str,
    workspace_id: &str,
    group_id: &str,
) {
    sqlx::query(
        "INSERT INTO workspace_access (id, workspace_id, group_id, updated_at)
         VALUES ($1, $2, $3, NOW())",
    )
    .bind(id)
    .bind(workspace_id)
    .bind(group_id)
    .execute(pool)
    .await
    .expect("seed workspace_access (group)");
}

pub(crate) async fn seed_group(pool: &PgPool, id: &str, org_id: &str) {
    sqlx::query(
        "INSERT INTO groups (id, organization_id, name, updated_at) VALUES ($1, $2, $1, NOW())",
    )
    .bind(id)
    .bind(org_id)
    .execute(pool)
    .await
    .expect("seed groups");
}

pub(crate) async fn seed_group_member(pool: &PgPool, group_id: &str, user_id: &str) {
    sqlx::query("INSERT INTO group_members (group_id, user_id, updated_at) VALUES ($1, $2, NOW())")
        .bind(group_id)
        .bind(user_id)
        .execute(pool)
        .await
        .expect("seed group_members");
}

/// Best-effort teardown of everything a test created, scoped by its unique
/// prefix. Children before parents so the deletes never trip an FK — this
/// does not lean on any cascade behaviour the schema may or may not define.
pub(crate) async fn cleanup(pool: &PgPool, prefix: &str) {
    let like = format!("{prefix}%");
    for stmt in [
        "DELETE FROM group_members WHERE group_id LIKE $1 OR user_id LIKE $1",
        "DELETE FROM workspace_access WHERE id LIKE $1 OR workspace_id LIKE $1 OR user_id LIKE $1 OR group_id LIKE $1",
        "DELETE FROM groups WHERE id LIKE $1 OR organization_id LIKE $1",
        "DELETE FROM organization_members WHERE organization_id LIKE $1 OR user_id LIKE $1",
        "DELETE FROM workspaces WHERE id LIKE $1 OR organization_id LIKE $1",
        "DELETE FROM users WHERE id LIKE $1",
        "DELETE FROM organizations WHERE id LIKE $1",
    ] {
        let _ = sqlx::query(stmt).bind(&like).execute(pool).await;
    }
}
