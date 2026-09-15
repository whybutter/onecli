//! Spend accounting: the hot cache counter, the durable Postgres floor, and
//! the enforcement predicate over them.
//!
//! Two stores back one number per `(secret_id, subject, period)`:
//! - a cache counter (`CacheStore`), read on every request (`is_over_budget`,
//!   the hot path) and written off the request path by `add_spend`;
//! - the durable `budget_spends` floor, written by `add_spend` and read only
//!   to rehydrate the cache on a miss (`read_spent_nanos`).
//!
//! `add_spend` writes the cache BEFORE the floor (`incrby` first), and the
//! floor read only ever RAISES the cache back up ("reconcile-as-floor") —
//! never lowers it. A concurrent flush can have already pushed the cache
//! ahead of what this call's own durable upsert reports (its own charge plus
//! one it doesn't know about yet), and a blind overwrite would roll that
//! newer charge back, letting spend through twice. See `add_spend`.

use cache::CacheStore;
use tracing::warn;

use super::{BudgetBinding, BudgetPeriod};

/// Durable floor TTL for a lifetime (`Total`) budget's hot counter. Bounds how
/// long a `Total` counter can go without a floor rehydrate rather than
/// meaning anything about the budget's own lifetime.
const TOTAL_TTL_SECS: u64 = 90 * 86_400;

/// The spend-window key: `m:YYYY-MM` (UTC) for `Monthly` (a new month is a new
/// key = automatic reset), `total` for `Total` (lifetime). Takes `now`
/// explicitly (see [`period_key`]) rather than reading the clock itself, so a
/// caller that also needs the TTL derives both from the SAME instant.
fn period_key_at(period: BudgetPeriod, now: time::OffsetDateTime) -> String {
    match period {
        BudgetPeriod::Total => "total".to_string(),
        BudgetPeriod::Monthly => format!("m:{:04}-{:02}", now.year(), now.month() as u8),
    }
}

/// [`period_key_at`] against the current instant. Prefer [`period_key_at`]
/// with a shared `now` wherever the TTL is also being computed — two separate
/// `now_utc()` reads a moment apart could straddle a month boundary and pair
/// a September key with an October TTL formula.
pub fn period_key(period: BudgetPeriod) -> String {
    period_key_at(period, time::OffsetDateTime::now_utc())
}

/// The hot-counter cache key. One format string for every read and write.
fn cache_key(secret_id: &str, subject: &str, period_key: &str) -> String {
    format!("budget:spend:{secret_id}:{subject}:{period_key}")
}

/// Seconds until the counter should next be forced to rehydrate from the
/// durable floor: through end of `now`'s UTC month for `Monthly`, a fixed 90
/// days for `Total`. Takes `now` explicitly — see [`period_key_at`].
fn ttl_secs_at(period: BudgetPeriod, now: time::OffsetDateTime) -> u64 {
    match period {
        BudgetPeriod::Total => TOTAL_TTL_SECS,
        BudgetPeriod::Monthly => {
            let days_remaining =
                u64::from(now.month().length(now.year())) - u64::from(now.day()) + 1;
            days_remaining * 86_400
        }
    }
}

/// TTL for an already-rendered `period_key` string (`"total"` or
/// `"m:YYYY-MM"`), used where there is no shared `now` to derive it from —
/// `add_spend` runs off the telemetry flush, potentially seconds (a whole
/// batch interval) after the charge's `period_key` was minted in the meter,
/// so re-deriving the month from a freshly-read clock here could pair a
/// stale key with the WRONG month's day count across a boundary. The month
/// is instead parsed straight out of the key, and the TTL is that month's
/// FULL length rather than "days remaining" (which needs to know where in
/// the month the key was first created, information the string doesn't
/// carry) — a harmless, bounded overshoot: `CacheStore::incrby` only applies
/// a TTL on a brand-new key, so this formula only matters when `add_spend`
/// happens to be the first write to a period's counter.
fn ttl_secs_for_period_key(period_key: &str) -> u64 {
    let parsed = period_key.strip_prefix("m:").and_then(|rest| {
        let (year_str, month_str) = rest.split_once('-')?;
        let year: i32 = year_str.parse().ok()?;
        let month_num: u8 = month_str.parse().ok()?;
        let month = time::Month::try_from(month_num).ok()?;
        Some((year, month))
    });
    match parsed {
        Some((year, month)) => u64::from(month.length(year)) * 86_400,
        // "total", or an unrecognized shape — fall back to the Total TTL
        // rather than guessing at a monthly one.
        None => TOTAL_TTL_SECS,
    }
}

async fn db_floor_nanos(pool: &sqlx::PgPool, secret_id: &str, subject: &str, period: &str) -> i64 {
    match sqlx::query_scalar::<_, i64>(
        "SELECT spent_nanos FROM budget_spends \
         WHERE secret_id = $1 AND organization_id = $2 AND period = $3",
    )
    .bind(secret_id)
    .bind(subject)
    .bind(period)
    .fetch_optional(pool)
    .await
    {
        Ok(Some(nanos)) => nanos,
        Ok(None) => 0,
        Err(error) => {
            warn!(%error, secret_id, subject, period, "budget: failed to read the spend floor; treating as 0 (fail-open)");
            0
        }
    }
}

/// Read the current spend for a binding's counter, rehydrating from the
/// durable floor on a cache miss.
///
/// Clobber window (accepted, documented): if a flush-time `incrby` lands
/// between the floor read and the `set_raw` below, the `set_raw` overwrites
/// it — an undercount of at most one flush batch, repaired at the next
/// miss/rollover. A `SET NX` would tighten this; not worth the extra
/// round-trip for a cost control (see the module doc on fail-open budgets).
pub async fn read_spent_nanos(
    cache: &dyn CacheStore,
    pool: &sqlx::PgPool,
    binding: &BudgetBinding,
) -> i64 {
    // Computed once and threaded through both the key and the TTL below — see
    // `period_key_at`'s doc for why two separate `now_utc()` reads would be
    // unsafe here.
    let now = time::OffsetDateTime::now_utc();
    let period_key = period_key_at(binding.period, now);
    let subject = binding.subject.to_string();
    let key = cache_key(&binding.secret_id, &subject, &period_key);

    if let Some(raw) = cache.get_raw(&key).await {
        // The cache only ever stores an unsigned counter (`CacheStore::incrby`
        // / the durable total written back by `add_spend`'s reconcile step),
        // so a value that doesn't fit `i64` is clamped to `i64::MAX` rather
        // than treated as a parse failure: silently reading it as `0` would
        // fail OPEN on a budget that has in fact been spent far past its
        // limit. Only a genuinely unparseable string (corruption) reads as 0.
        return raw
            .parse::<u64>()
            .map_or(0, |nanos| nanos.min(i64::MAX as u64) as i64);
    }

    let floor = db_floor_nanos(pool, &binding.secret_id, &subject, &period_key).await;
    cache
        .set_raw(&key, &floor.to_string(), ttl_secs_at(binding.period, now))
        .await;
    floor
}

/// Enforcement predicate: `>=`, inclusive — a request that lands exactly on
/// the limit is blocked. Fail-open on any read failure (`read_spent_nanos`
/// already resolves those to `0`), so a budget subsystem outage degrades to
/// "no cap enforced" rather than "every request blocked."
pub async fn is_over_budget(
    cache: &dyn CacheStore,
    pool: &sqlx::PgPool,
    binding: &BudgetBinding,
) -> bool {
    read_spent_nanos(cache, pool, binding).await >= binding.limit_nanos
}

async fn upsert_budget_spend(
    pool: &sqlx::PgPool,
    secret_id: &str,
    subject: &str,
    period: &str,
    nanos: i64,
) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar::<_, i64>(
        "INSERT INTO budget_spends (secret_id, organization_id, period, spent_nanos, updated_at) \
         VALUES ($1, $2, $3, $4, NOW()) \
         ON CONFLICT (secret_id, organization_id, period) \
         DO UPDATE SET spent_nanos = budget_spends.spent_nanos + EXCLUDED.spent_nanos, updated_at = NOW() \
         RETURNING spent_nanos",
    )
    .bind(secret_id)
    .bind(subject)
    .bind(period)
    .bind(nanos)
    .fetch_one(pool)
    .await
}

/// Apply a metered charge. Reached from the free `telemetry` crate's flush
/// loop via the installed `SpendSink` (`BudgetSpendSink` in `budget.rs`),
/// off the request hot path — every failure here is logged, never
/// propagated, per the module's fail-open posture.
///
/// INVARIANT: `nanos` must be `> 0`. The telemetry flush already drops
/// non-positive charges before this is ever called (`flush_budget` sums
/// `cost_nanos` per key and skips a total `<= 0`), and this is checked again
/// here because it is exactly what keeps the unsigned `CacheStore::incrby`
/// cast below safe — an `i64` that reached here `<= 0` would otherwise wrap
/// into a huge `u64` and silently blow the counter up instead of leaving it
/// alone.
pub async fn add_spend(
    cache: &dyn CacheStore,
    pool: &sqlx::PgPool,
    secret_id: &str,
    subject: &str,
    period_key: &str,
    nanos: i64,
) {
    if nanos <= 0 {
        return;
    }

    let key = cache_key(secret_id, subject, period_key);
    let ttl = ttl_secs_for_period_key(period_key);

    // (a) Hot counter first — `is_over_budget` reads this, so the gate feels
    // the charge as soon as possible rather than waiting on the DB round-trip
    // below.
    if cache.incrby(&key, nanos as u64, ttl).await.is_none() {
        warn!(
            secret_id,
            subject,
            period_key,
            "budget: cache incrby failed; spend not reflected in the hot counter"
        );
    }

    // (b) Durable insert.
    let total = match upsert_budget_spend(pool, secret_id, subject, period_key, nanos).await {
        Ok(total) => total,
        Err(error) => {
            warn!(%error, secret_id, subject, period_key, "budget: failed to persist spend");
            return;
        }
    };

    // (c) Reconcile-as-floor: raise the cache to the durable total if it fell
    // behind (cold start, an evicted key, a lost increment) — but NEVER lower
    // it. See the module doc for why a blind overwrite here is unsafe.
    //
    // Parsed as `u64`, matching what the cache actually stores
    // (`CacheStore::incrby`'s counter): treating an above-`i64::MAX` cached
    // value as "unparseable" here would read as `None`, and `None` compares
    // as "behind" below — silently LOWERING a huge cache value down to this
    // call's own (much smaller) durable total, exactly the clobber this
    // reconcile step exists to prevent.
    let cached = cache
        .get_raw(&key)
        .await
        .and_then(|raw| raw.parse::<u64>().ok());
    let total_u64 = u64::try_from(total).unwrap_or(0);
    if cached.is_none_or(|current| current < total_u64) {
        cache.set_raw(&key, &total.to_string(), ttl).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use time::{Date, Month, OffsetDateTime};

    fn utc(year: i32, month: Month, day: u8) -> OffsetDateTime {
        Date::from_calendar_date(year, month, day)
            .unwrap()
            .midnight()
            .assume_utc()
    }

    #[test]
    fn period_key_formats() {
        assert_eq!(period_key(BudgetPeriod::Total), "total");
        // Monthly is time-dependent (UTC "now"), so just pin the shape.
        let key = period_key(BudgetPeriod::Monthly);
        assert!(key.starts_with("m:"), "got {key:?}");
        assert_eq!(key.len(), "m:YYYY-MM".len());
    }

    #[test]
    fn cache_key_format() {
        assert_eq!(
            cache_key("platform:anthropic", "user:u1", "total"),
            "budget:spend:platform:anthropic:user:u1:total"
        );
    }

    #[test]
    fn period_key_at_and_ttl_secs_at_agree_on_the_same_now() {
        // The whole point of taking `now` explicitly: a key minted at 23:59:59
        // on the 30th and a TTL computed a moment later at 00:00:00 on the 1st
        // must not disagree about which month they're in. Passing one shared
        // `now` to both makes that impossible by construction.
        let now = utc(2026, Month::September, 30);
        assert_eq!(period_key_at(BudgetPeriod::Monthly, now), "m:2026-09");
        assert_eq!(ttl_secs_at(BudgetPeriod::Monthly, now), 86_400); // just the 30th left.
    }

    #[test]
    fn total_ttl_is_ninety_days() {
        assert_eq!(
            ttl_secs_at(BudgetPeriod::Total, utc(2026, Month::September, 30)),
            90 * 86_400
        );
        assert_eq!(ttl_secs_for_period_key("total"), 90 * 86_400);
    }

    // `ttl_secs_at(Monthly, ..)` pins the formula shape via
    // `days_in_month - day + 1`, matching `proxy::hooks::quota_key_and_ttl`.
    #[test]
    fn monthly_ttl_reaches_end_of_month() {
        let now = utc(2024, Month::February, 28); // 2024 is a leap year: 29 days.
        assert_eq!(ttl_secs_at(BudgetPeriod::Monthly, now), 172_800); // the 28th and the 29th.
    }

    #[test]
    fn ttl_for_period_key_is_derived_from_the_keys_own_month_not_the_clock() {
        // 2024 is a leap year: February has 29 days. This must hold
        // regardless of what day `now()` happens to be when this runs.
        assert_eq!(ttl_secs_for_period_key("m:2024-02"), 29 * 86_400);
        assert_eq!(ttl_secs_for_period_key("m:2026-09"), 30 * 86_400);
        // An unparseable or unrecognized shape falls back to the Total TTL
        // rather than guessing at a month.
        assert_eq!(ttl_secs_for_period_key("garbage"), 90 * 86_400);
        assert_eq!(ttl_secs_for_period_key("m:not-a-month"), 90 * 86_400);
    }

    #[tokio::test]
    async fn is_over_budget_is_inclusive_at_the_limit() {
        let cache = cache::in_memory();
        let binding = BudgetBinding {
            secret_id: "sec1".to_string(),
            subject: super::super::BudgetSubject::Org("org1".to_string()),
            secret_type: "anthropic".to_string(),
            limit_nanos: 5_000_000_000,
            period: BudgetPeriod::Total,
        };
        let key = cache_key("sec1", "org:org1", "total");
        cache.set_raw(&key, "5000000000", 3600).await;

        // No pool touch expected on a cache hit — pass an unconnected pool
        // lazily; `read_spent_nanos` must not reach it when the cache hits.
        let pool = sqlx::PgPool::connect_lazy("postgres://unused/unused").unwrap();
        assert!(
            is_over_budget(&*cache, &pool, &binding).await,
            "spend exactly at the limit must block (>=, not >)"
        );
    }

    #[tokio::test]
    async fn add_spend_ignores_a_non_positive_delta() {
        let cache = cache::in_memory();
        let pool = sqlx::PgPool::connect_lazy("postgres://unused/unused").unwrap();
        // Must return without touching the (unconnected) pool at all.
        add_spend(&*cache, &pool, "sec1", "org:org1", "total", 0).await;
        add_spend(&*cache, &pool, "sec1", "org:org1", "total", -5).await;
        assert!(cache
            .get_raw(&cache_key("sec1", "org:org1", "total"))
            .await
            .is_none());
    }

    mod db_tests {
        use super::super::super::pg_test_support::*;
        use super::super::*;

        #[tokio::test]
        async fn read_spent_nanos_rehydrates_from_the_durable_floor_on_a_cold_cache() {
            let Some(pool) = test_pool().await else {
                return;
            };
            let org_id = unique_id("org");
            let secret_id = unique_id("sec");
            insert_org(&pool, &org_id).await;
            insert_secret(&pool, &secret_id, &org_id, "organization", "anthropic").await;

            let subject = format!("org:{org_id}");
            insert_budget_spend(&pool, &secret_id, &subject, "total", 42_000_000).await;

            let binding = BudgetBinding {
                secret_id: secret_id.clone(),
                subject: super::super::super::BudgetSubject::Org(org_id.clone()),
                secret_type: "anthropic".to_string(),
                limit_nanos: 1_000_000_000,
                period: BudgetPeriod::Total,
            };
            let cache = cache::in_memory();

            let spent = read_spent_nanos(&*cache, &pool, &binding).await;
            assert_eq!(
                spent, 42_000_000,
                "a cache miss must rehydrate from the durable floor"
            );

            let key = cache_key(&secret_id, &subject, "total");
            assert_eq!(
                cache.get_raw(&key).await.as_deref(),
                Some("42000000"),
                "the floor must be written back so the next read is a cache hit"
            );

            cleanup(&pool, &org_id, &[&secret_id]).await;
        }

        #[tokio::test]
        async fn add_spend_raises_the_cache_to_the_durable_total_when_it_fell_behind() {
            let Some(pool) = test_pool().await else {
                return;
            };
            let org_id = unique_id("org");
            let secret_id = unique_id("sec");
            insert_org(&pool, &org_id).await;
            insert_secret(&pool, &secret_id, &org_id, "organization", "anthropic").await;

            let subject = format!("org:{org_id}");
            // A pre-existing durable floor the cache doesn't know about yet —
            // simulates a lost increment / evicted key.
            insert_budget_spend(&pool, &secret_id, &subject, "total", 100_000_000).await;

            let cache = cache::in_memory();
            add_spend(&*cache, &pool, &secret_id, &subject, "total", 1_000_000).await;

            let key = cache_key(&secret_id, &subject, "total");
            assert_eq!(
                cache.get_raw(&key).await.as_deref(),
                Some("101000000"),
                "the cache must be raised to the durable total (100M existing + 1M charged)"
            );

            cleanup(&pool, &org_id, &[&secret_id]).await;
        }

        #[tokio::test]
        async fn add_spend_never_lowers_a_cache_a_newer_concurrent_charge_already_raised() {
            let Some(pool) = test_pool().await else {
                return;
            };
            let org_id = unique_id("org");
            let secret_id = unique_id("sec");
            insert_org(&pool, &org_id).await;
            insert_secret(&pool, &secret_id, &org_id, "organization", "anthropic").await;

            let subject = format!("org:{org_id}");
            let cache = cache::in_memory();
            let key = cache_key(&secret_id, &subject, "total");

            // A later flush batch's charge has already landed in the cache
            // (via its own `incrby`) before this call's durable upsert
            // completes — the race the reconcile step must not undo.
            cache.set_raw(&key, "9000000000", 86_400).await;

            add_spend(&*cache, &pool, &secret_id, &subject, "total", 1_000_000).await;

            // This call's own `incrby` still applies (that delta is real and
            // must land); what must NOT happen is the reconcile step
            // clobbering the result down to this call's own (much smaller)
            // durable total.
            assert_eq!(
                cache.get_raw(&key).await.as_deref(),
                Some("9001000000"),
                "the reconcile step must never lower the cache below what a newer charge already put there"
            );

            cleanup(&pool, &org_id, &[&secret_id]).await;
        }
    }
}
