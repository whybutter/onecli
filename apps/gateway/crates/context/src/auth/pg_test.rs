//! `api_keys.last_used_at` stamp DB tests (phase2-plan Risk 8 — the
//! gateway-side stamp deferred to the Phase 1 + Phase 2 integration step),
//! driving `validate_api_key` + `stamp_api_key_use` against a real Postgres.
//!
//! Same convention as `ee::rbac::pg_test` / `policy_engine::enforce_pg_test`:
//! gated on `GATEWAY_TEST_DATABASE_URL` (skipped locally when unset, MUST run
//! in CI). Each test seeds its own rows under a fresh random prefix and tears
//! them down with `cleanup`, so the suite can run repeatedly, and
//! concurrently with other crates' DB tests, against one shared database.

use std::sync::Once;

use hyper::HeaderMap;
use sqlx::PgPool;

use super::{install_role_resolver, validate_api_key, RoleResolver};

async fn test_pool() -> Option<PgPool> {
    let Ok(url) = std::env::var("GATEWAY_TEST_DATABASE_URL") else {
        assert!(
            std::env::var("CI").is_err(),
            "GATEWAY_TEST_DATABASE_URL must be set in CI: the api_keys.last_used_at DB tests must not silently skip"
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

/// A short, collision-resistant prefix for one test's rows.
fn test_prefix(case: &str) -> String {
    format!("authtest-{case}-{}", uuid::Uuid::new_v4().simple())
}

// `updated_at` on these tables is `@updatedAt` in Prisma: NOT NULL with no DB
// default (Prisma sets it application-side), so every raw insert here must
// supply it explicitly.

async fn seed_org(pool: &PgPool, id: &str) {
    sqlx::query(
        "INSERT INTO organizations (id, name, slug, updated_at) VALUES ($1, $1, $1, NOW())",
    )
    .bind(id)
    .execute(pool)
    .await
    .expect("seed organizations");
}

async fn seed_user(pool: &PgPool, id: &str) {
    sqlx::query(
        "INSERT INTO users (id, email, external_auth_id, updated_at)
         VALUES ($1, $1 || '@authtest.invalid', $1, NOW())",
    )
    .bind(id)
    .execute(pool)
    .await
    .expect("seed users");
}

async fn seed_membership(pool: &PgPool, org_id: &str, user_id: &str, role: &str, status: &str) {
    sqlx::query(
        "INSERT INTO organization_members (organization_id, user_id, user_email, role, status)
         VALUES ($1, $2, $2 || '@authtest.invalid', $3, $4)",
    )
    .bind(org_id)
    .bind(user_id)
    .bind(role)
    .bind(status)
    .execute(pool)
    .await
    .expect("seed organization_members");
}

/// Seed an org-scoped (`oc_org_*`) API key row directly — `kind: "user"`,
/// `scope: "organization"`, matching what `regenerateApiKey`/`ensureApiKey`
/// produce on the API side.
async fn seed_org_api_key(pool: &PgPool, id: &str, key: &str, org_id: &str, user_id: &str) {
    sqlx::query(
        "INSERT INTO api_keys (id, key, user_id, user_email, organization_id, scope, kind, updated_at)
         VALUES ($1, $2, $3, $3 || '@authtest.invalid', $4, 'organization', 'user', NOW())",
    )
    .bind(id)
    .bind(key)
    .bind(user_id)
    .bind(org_id)
    .execute(pool)
    .await
    .expect("seed api_keys (org key)");
}

/// Read `last_used_at` back as text — the workspace's `sqlx` build carries no
/// `time`/`chrono` feature (nothing else in the gateway decodes a timestamp
/// column into a typed Rust value; every other read compares dates in SQL),
/// so a `::text` cast is the least-friction way for a test to observe the
/// column's null-ness and, for the throttle test, its exact stamped value.
async fn last_used_at(pool: &PgPool, key: &str) -> Option<String> {
    let row: (Option<String>,) =
        sqlx::query_as("SELECT last_used_at::text FROM api_keys WHERE key = $1")
            .bind(key)
            .fetch_one(pool)
            .await
            .expect("read api_keys.last_used_at");
    row.0
}

/// Best-effort teardown of everything a test created, scoped by its unique
/// prefix. Children before parents so the deletes never trip an FK.
async fn cleanup(pool: &PgPool, prefix: &str) {
    let like = format!("{prefix}%");
    for stmt in [
        "DELETE FROM api_keys WHERE id LIKE $1 OR key LIKE $1 OR user_id LIKE $1 OR organization_id LIKE $1",
        "DELETE FROM organization_members WHERE organization_id LIKE $1 OR user_id LIKE $1",
        "DELETE FROM users WHERE id LIKE $1",
        "DELETE FROM organizations WHERE id LIKE $1",
    ] {
        let _ = sqlx::query(stmt).bind(&like).execute(pool).await;
    }
}

/// A role resolver that reads REAL rows — these DB tests need genuine
/// enforcement (a "member" org key must fail the admin recheck), not a stub
/// that always allows. Mirrors the shape of `ee::rbac::user_is_org_admin`
/// closely enough for the one recheck these tests exercise.
struct TestRoleResolver;

#[async_trait::async_trait]
impl RoleResolver for TestRoleResolver {
    async fn user_is_org_admin(
        &self,
        pool: &PgPool,
        user_id: &str,
        organization_id: &str,
    ) -> anyhow::Result<bool> {
        let row: Option<(String,)> = sqlx::query_as(
            "SELECT role FROM organization_members
              WHERE user_id = $1 AND organization_id = $2 AND status = 'active'",
        )
        .bind(user_id)
        .bind(organization_id)
        .fetch_optional(pool)
        .await?;
        Ok(matches!(row, Some((role,)) if role == "admin" || role == "owner"))
    }

    async fn user_can_manage_workspace(
        &self,
        _pool: &PgPool,
        _user_id: &str,
        _workspace_id: &str,
    ) -> anyhow::Result<bool> {
        // Not exercised by these org-key tests.
        Ok(true)
    }
}

/// Install the fake resolver exactly once — `install_role_resolver` panics on
/// a second call, and every test in this binary shares the process-wide
/// `OnceLock`.
fn ensure_role_resolver_installed() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        install_role_resolver(Box::new(TestRoleResolver));
    });
}

/// A successful org-key authentication (admin/owner, liveness + role recheck
/// both pass) stamps `last_used_at` from NULL to non-null.
#[tokio::test]
async fn first_successful_auth_stamps_last_used_at() {
    let Some(pool) = test_pool().await else {
        return;
    };
    ensure_role_resolver_installed();
    let p = test_prefix("stamp");
    let (org, user, key) = (
        format!("{p}-org"),
        format!("{p}-user"),
        format!("oc_org_{p}"),
    );
    seed_org(&pool, &org).await;
    seed_user(&pool, &user).await;
    seed_membership(&pool, &org, &user, "admin", "active").await;
    seed_org_api_key(&pool, &format!("{p}-key"), &key, &org, &user).await;

    assert!(
        last_used_at(&pool, &key).await.is_none(),
        "sanity: freshly minted key starts unused"
    );

    let auth = validate_api_key(&pool, &key, &HeaderMap::new())
        .await
        .expect("admin org key must authenticate");
    super::stamp_api_key_use(&pool, &key).await;

    assert_eq!(auth.organization_id.as_deref(), Some(org.as_str()));
    assert!(
        last_used_at(&pool, &key).await.is_some(),
        "a key that authenticated successfully must be stamped"
    );
    cleanup(&pool, &p).await;
}

/// A second authentication within the 15-minute throttle window must NOT move
/// the timestamp forward — the whole point of throttling the write.
#[tokio::test]
async fn second_auth_within_throttle_window_does_not_change_timestamp() {
    let Some(pool) = test_pool().await else {
        return;
    };
    ensure_role_resolver_installed();
    let p = test_prefix("throttle");
    let (org, user, key) = (
        format!("{p}-org"),
        format!("{p}-user"),
        format!("oc_org_{p}"),
    );
    seed_org(&pool, &org).await;
    seed_user(&pool, &user).await;
    seed_membership(&pool, &org, &user, "owner", "active").await;
    seed_org_api_key(&pool, &format!("{p}-key"), &key, &org, &user).await;

    validate_api_key(&pool, &key, &HeaderMap::new())
        .await
        .expect("owner org key must authenticate");
    super::stamp_api_key_use(&pool, &key).await;
    let first_stamp = last_used_at(&pool, &key)
        .await
        .expect("first auth must stamp");

    // Immediately authenticate again — well within the 15-minute window.
    validate_api_key(&pool, &key, &HeaderMap::new())
        .await
        .expect("owner org key must authenticate again");
    super::stamp_api_key_use(&pool, &key).await;
    let second_stamp = last_used_at(&pool, &key)
        .await
        .expect("still stamped from the first write");

    assert_eq!(
        first_stamp, second_stamp,
        "a re-auth inside the throttle window must not move the timestamp"
    );
    cleanup(&pool, &p).await;
}

/// A failed authentication — a plain member's org key hitting the admin
/// recheck — must never stamp. The row must read exactly as unused as it did
/// before the request.
#[tokio::test]
async fn failed_role_recheck_does_not_stamp() {
    let Some(pool) = test_pool().await else {
        return;
    };
    ensure_role_resolver_installed();
    let p = test_prefix("denied");
    let (org, user, key) = (
        format!("{p}-org"),
        format!("{p}-user"),
        format!("oc_org_{p}"),
    );
    seed_org(&pool, &org).await;
    seed_user(&pool, &user).await;
    // A plain member — org keys are an admin capability, so this must fail
    // the role recheck inside `validate_api_key`.
    seed_membership(&pool, &org, &user, "member", "active").await;
    seed_org_api_key(&pool, &format!("{p}-key"), &key, &org, &user).await;

    let result = validate_api_key(&pool, &key, &HeaderMap::new()).await;
    assert!(
        result.is_err(),
        "a member's org key must fail the admin recheck"
    );
    assert!(
        last_used_at(&pool, &key).await.is_none(),
        "a key that failed to authenticate must never be stamped"
    );
    cleanup(&pool, &p).await;
}
