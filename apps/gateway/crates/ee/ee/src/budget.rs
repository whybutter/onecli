//! Spend budgets on org secrets carrying an Anthropic credential.
//!
//! Data flow (`docs/upstream-sync/v2-migration/phase1-plan.md` WP-B lists the
//! same steps 1-9; full behaviour in `gateway-ee-behaviour.md` §4):
//!
//! 1. `proxy::connect` resolves the host-filtered, rule-selected secret pool
//!    for the request (`matching: Vec<db::SecretRow>`).
//! 2. [`resolve_bindings`] loads any `budgets` rows for those secrets in this
//!    org and turns each into a [`BudgetBinding`].
//! 3. `proxy::hooks::pre_forward` calls [`is_over_budget`] on every binding
//!    before forwarding.
//! 4. [`is_over_budget`] reads the hot spend counter (`spend::read_spent_nanos`),
//!    rehydrating it from the durable `budget_spends` floor on a cache miss.
//! 5. For a 2xx response on a metered binding, `proxy::hooks::track_and_wrap`
//!    calls [`wrap_metered`], which meters the stream and fires exactly one
//!    telemetry event carrying a `BudgetCharge` at end of stream (or on drop).
//! 6. `pricing::cost_nanos` prices the parsed usage.
//! 7. The free `telemetry::flush_budget` aggregates charges per
//!    `(secret_id, subject, period_key)` and calls the installed
//!    [`telemetry::SpendSink`] — [`BudgetSpendSink`] below.
//! 8. [`add_spend`] applies the charge: hot counter first
//!    (`CacheStore::incrby`), then a durable upsert, then reconciles the
//!    cache up to the durable total (never down).
//!
//! Metering is Anthropic-only in this phase (vetting decision 1,
//! `phase1-plan.md`): OpenAI metering is an explicit follow-up, not built
//! here. See [`meter::has_meter`].

mod anthropic;
mod binding;
mod meter;
mod pricing;
mod spend;

pub use binding::resolve_bindings;
pub use meter::{has_meter, wrap_metered};
pub use spend::{add_spend, is_over_budget};

/// How often a budget resets. Serialized lowercase — this value is part of
/// the cached `ConnectResponse` wire shape (`proxy::connect`), so the
/// encoding is load-bearing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BudgetPeriod {
    Monthly,
    Total,
}

/// Who a budget's spend is attributed to. Encoded as a single prefixed string
/// (`org:<id>` / `user:<id>`) on the wire — this is also the shape stored in
/// the `budget_spends.organization_id` column, so the prefix rule is
/// load-bearing, not cosmetic. An unprefixed string fails to parse: a stale
/// cached `ConnectResponse` from before this shape existed then reads as a
/// deserialize error rather than silent misattribution.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(into = "String", try_from = "String")]
pub enum BudgetSubject {
    Org(String),
    User(String),
}

impl std::fmt::Display for BudgetSubject {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            BudgetSubject::Org(id) => write!(f, "org:{id}"),
            BudgetSubject::User(id) => write!(f, "user:{id}"),
        }
    }
}

impl From<BudgetSubject> for String {
    fn from(subject: BudgetSubject) -> Self {
        subject.to_string()
    }
}

impl TryFrom<String> for BudgetSubject {
    type Error = String;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        if let Some(id) = value.strip_prefix("org:") {
            Ok(BudgetSubject::Org(id.to_string()))
        } else if let Some(id) = value.strip_prefix("user:") {
            Ok(BudgetSubject::User(id.to_string()))
        } else {
            Err(format!(
                "invalid budget subject {value:?}: expected an \"org:\" or \"user:\" prefix"
            ))
        }
    }
}

/// A resolved budget governing one secret's spend, for one subject, over one
/// period. Threaded from `resolve_bindings` through `ConnectResponse` /
/// `ResolvedRules`, so it must stay `Debug + Clone + PartialEq + Serialize +
/// Deserialize` (it is cached as JSON).
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct BudgetBinding {
    pub secret_id: String,
    pub subject: BudgetSubject,
    pub secret_type: String,
    pub limit_nanos: i64,
    pub period: BudgetPeriod,
}

/// Installed unconditionally at startup (`wiring.rs`, before `telemetry::init`)
/// so `telemetry::flush_budget` never warns about a missing sink. A thin
/// forward onto [`spend::add_spend`] — this struct exists only to give the
/// free `telemetry::SpendSink` trait a concrete, unit-struct implementor the
/// composition root can construct positionally.
pub struct BudgetSpendSink;

#[async_trait::async_trait]
impl telemetry::SpendSink for BudgetSpendSink {
    async fn add_spend(
        &self,
        cache: &dyn cache::CacheStore,
        pool: &sqlx::PgPool,
        secret_id: &str,
        subject: &str,
        period_key: &str,
        nanos: i64,
    ) {
        spend::add_spend(cache, pool, secret_id, subject, period_key, nanos).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn budget_period_serializes_snake_case() {
        assert_eq!(
            serde_json::to_string(&BudgetPeriod::Monthly).unwrap(),
            "\"monthly\""
        );
        assert_eq!(
            serde_json::to_string(&BudgetPeriod::Total).unwrap(),
            "\"total\""
        );
    }

    #[test]
    fn budget_subject_renders_and_round_trips() {
        let org = BudgetSubject::Org("o1".to_string());
        assert_eq!(org.to_string(), "org:o1");
        assert_eq!(serde_json::to_string(&org).unwrap(), "\"org:o1\"");
        let round_tripped: BudgetSubject = serde_json::from_str("\"org:o1\"").unwrap();
        assert_eq!(round_tripped, org);

        let user = BudgetSubject::User("u1".to_string());
        assert_eq!(user.to_string(), "user:u1");
        let round_tripped: BudgetSubject = serde_json::from_str("\"user:u1\"").unwrap();
        assert_eq!(round_tripped, user);
    }

    #[test]
    fn budget_subject_rejects_an_unprefixed_string() {
        let result: Result<BudgetSubject, _> = serde_json::from_str("\"o1\"");
        assert!(
            result.is_err(),
            "an unprefixed subject must fail to parse, not silently misattribute spend"
        );
    }
}

/// Shared real-Postgres fixture helpers for the DB tests in `binding` and
/// `spend`. An inline module (not its own file) deliberately — the plan
/// enumerates exactly five submodule files (`binding`, `spend`, `meter`,
/// `pricing`, `anthropic`), matching the upstream layout in
/// `docs/upstream-sync/v2-migration/rust-seams.md` §B, so this stays test-only
/// code embedded in the mod file rather than a sixth production module.
#[cfg(test)]
pub(crate) mod pg_test_support {
    use sqlx::postgres::PgPoolOptions;
    use sqlx::PgPool;

    /// Skip locally when `GATEWAY_TEST_DATABASE_URL` is unset; CI always wires
    /// it (`.github/workflows/ci.yml`) and must not silently skip — same
    /// convention as `policy_engine::enforce_pg_test::test_pool`.
    pub(crate) async fn test_pool() -> Option<PgPool> {
        let Ok(url) = std::env::var("GATEWAY_TEST_DATABASE_URL") else {
            assert!(
                std::env::var("CI").is_err(),
                "GATEWAY_TEST_DATABASE_URL must be set in CI: the budget DB tests must not silently skip"
            );
            eprintln!("skipping: GATEWAY_TEST_DATABASE_URL unset");
            return None;
        };
        Some(
            PgPoolOptions::new()
                .max_connections(2)
                .connect(&url)
                .await
                .expect("connect to the budget test database"),
        )
    }

    /// A random, collision-proof id — these tests run against a shared,
    /// migrated database (not a scratch-per-test one), so every row they write
    /// must be uniquely and safely identifiable for cleanup.
    pub(crate) fn unique_id(prefix: &str) -> String {
        format!("{prefix}-{}", uuid::Uuid::new_v4())
    }

    // `updated_at` has no DB-level default anywhere in this schema (it is
    // maintained by Prisma's `@updatedAt` at the application layer), so every
    // direct insert below sets it explicitly.

    pub(crate) async fn insert_org(pool: &PgPool, id: &str) {
        sqlx::query(
            "INSERT INTO organizations (id, name, slug, updated_at) VALUES ($1, $1, $1, NOW())",
        )
        .bind(id)
        .execute(pool)
        .await
        .expect("insert test organization");
    }

    pub(crate) async fn insert_secret(
        pool: &PgPool,
        id: &str,
        org_id: &str,
        scope: &str,
        secret_type: &str,
    ) {
        sqlx::query(
            "INSERT INTO secrets (id, scope, organization_id, name, type, host_pattern, updated_at) \
             VALUES ($1, $2, $3, $1, $4, 'api.anthropic.com', NOW())",
        )
        .bind(id)
        .bind(scope)
        .bind(org_id)
        .bind(secret_type)
        .execute(pool)
        .await
        .expect("insert test secret");
    }

    pub(crate) async fn insert_budget(
        pool: &PgPool,
        org_id: &str,
        secret_id: &str,
        limit_cents: i32,
        period: &str,
    ) {
        sqlx::query(
            "INSERT INTO budgets (id, secret_id, organization_id, limit_cents, period, created_by, updated_at) \
             VALUES ($1, $2, $3, $4, $5, 'test', NOW())",
        )
        .bind(unique_id("budget"))
        .bind(secret_id)
        .bind(org_id)
        .bind(limit_cents)
        .bind(period)
        .execute(pool)
        .await
        .expect("insert test budget");
    }

    pub(crate) async fn insert_budget_spend(
        pool: &PgPool,
        secret_id: &str,
        subject: &str,
        period: &str,
        spent_nanos: i64,
    ) {
        sqlx::query(
            "INSERT INTO budget_spends (secret_id, organization_id, period, spent_nanos, updated_at) \
             VALUES ($1, $2, $3, $4, NOW())",
        )
        .bind(secret_id)
        .bind(subject)
        .bind(period)
        .bind(spent_nanos)
        .execute(pool)
        .await
        .expect("insert test budget spend");
    }

    /// Best-effort teardown in FK-safe order. `budget_spends` carries no FK to
    /// `organizations` (its column holds a rendered subject string, not an
    /// org id — see `BudgetSubject`), so it is cleaned up by secret id instead.
    pub(crate) async fn cleanup(pool: &PgPool, org_id: &str, secret_ids: &[&str]) {
        for secret_id in secret_ids {
            let _ = sqlx::query("DELETE FROM budget_spends WHERE secret_id = $1")
                .bind(secret_id)
                .execute(pool)
                .await;
        }
        let _ = sqlx::query("DELETE FROM budgets WHERE organization_id = $1")
            .bind(org_id)
            .execute(pool)
            .await;
        let _ = sqlx::query("DELETE FROM secrets WHERE organization_id = $1")
            .bind(org_id)
            .execute(pool)
            .await;
        let _ = sqlx::query("DELETE FROM organizations WHERE id = $1")
            .bind(org_id)
            .execute(pool)
            .await;
    }
}
