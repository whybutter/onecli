//! Resolve which of a request's host-filtered secrets carry a spend budget.
//!
//! Fork design decision (`gateway-ee-behaviour.md` §4.3 "Fork design note";
//! `phase1-plan.md` WP-B): upstream's eligibility predicate keys on secret
//! scope `"partner"`, which this fork never produces — so instead of porting
//! that dead rule, eligibility here is simply "the caller already decided
//! this secret is in scope for the request." `secrets` is the host-filtered,
//! rule-selected set `proxy::connect` resolved (`matching: Vec<db::SecretRow>`
//! in the free call site) — no separate shadowing/eligibility rule is
//! re-derived here; a budget binds whenever an admin created a `budgets` row
//! for a secret that is already going to be injected on this request,
//! regardless of whether that secret is org- or workspace-scoped.

use std::collections::HashMap;

use tracing::warn;

use super::{BudgetBinding, BudgetPeriod, BudgetSubject};

/// One cent = 1e7 nano-dollars (1e-9 USD).
const CENT_TO_NANOS: i64 = 10_000_000;

/// The fields `resolve_bindings` needs from a secret row to decide budget
/// eligibility. Implemented for `db::SecretRow` so the free `proxy::connect`
/// call site can pass its host-filtered secret pool directly.
pub trait BudgetSecret {
    fn id(&self) -> &str;
    fn scope(&self) -> &str;
    fn secret_type(&self) -> &str;
}

impl BudgetSecret for db::SecretRow {
    fn id(&self) -> &str {
        &self.id
    }

    fn scope(&self) -> &str {
        &self.scope
    }

    fn secret_type(&self) -> &str {
        &self.type_
    }
}

/// Resolve budget bindings for the org's `budgets` rows among a request's
/// host-filtered, rule-selected secrets (`secrets`). `_entitled` is accepted
/// (and ignored) only to keep the free `proxy::connect` call site — which
/// still passes `common::edition::entitled()` — compiling unchanged; every
/// budget in this fork is an OSS feature, not an entitlement-gated one.
///
/// DB error → warn + empty (fail-open: a budgets-table outage must never
/// itself become an outage for the credential it would have capped).
/// `limit_cents <= 0` → skip that row with a warn (a budget can never be a
/// silent permanent block via a misconfigured non-positive limit). Subject is
/// always `Org(org_id)` — the `User` subject is a documented Phase 1
/// follow-up, not built here.
///
/// Ordering is load-bearing, not incidental: `secrets` arrives in the same
/// order `proxy::connect` built `injection_rules` from (org secrets, then
/// workspace — see `resolve_secret_injections`), and `inject::apply_injections`
/// applies each rule's `HeaderMap::insert` in that order, so the LAST secret
/// in `secrets` whose rule matches the request path is the one whose
/// credential actually goes out on the wire ("last wins"). Meanwhile
/// `proxy::hooks::track_and_wrap` charges the FIRST metered binding it finds
/// in the Vec this function returns. Those two "firsts" must agree, or a
/// metered response gets attributed to a budgeted secret that was NOT the one
/// actually used. So bindings are emitted in REVERSE of `secrets`' order —
/// the effective (last-injected) secret's binding comes first — rather than
/// in the DB's arbitrary row order.
pub async fn resolve_bindings<S: BudgetSecret>(
    pool: &sqlx::PgPool,
    org_id: &str,
    secrets: &[S],
    _entitled: bool,
) -> Vec<BudgetBinding> {
    if secrets.is_empty() {
        return Vec::new();
    }

    let ids: Vec<String> = secrets.iter().map(|s| s.id().to_string()).collect();
    let rows: Vec<(String, i32, String)> = match sqlx::query_as(
        "SELECT secret_id, limit_cents, period FROM budgets \
         WHERE organization_id = $1 AND secret_id = ANY($2)",
    )
    .bind(org_id)
    .bind(&ids)
    .fetch_all(pool)
    .await
    {
        Ok(rows) => rows,
        Err(error) => {
            warn!(%error, org_id, "budget: failed to load bindings; enforcing none (fail-open)");
            return Vec::new();
        }
    };

    // Keyed by secret id so bindings can be built while walking `secrets` in
    // the order that determines metering attribution (see above), not the
    // order Postgres happened to return the rows in.
    let budget_by_secret_id: HashMap<&str, (i32, &str)> = rows
        .iter()
        .map(|(id, limit_cents, period)| (id.as_str(), (*limit_cents, period.as_str())))
        .collect();

    secrets
        .iter()
        .rev()
        .filter_map(|secret| {
            let (limit_cents, period) = *budget_by_secret_id.get(secret.id())?;
            if limit_cents <= 0 {
                warn!(
                    secret_id = secret.id(),
                    limit_cents, "budget: non-positive limit; skipping"
                );
                return None;
            }
            Some(BudgetBinding {
                secret_id: secret.id().to_string(),
                subject: BudgetSubject::Org(org_id.to_string()),
                secret_type: secret.secret_type().to_string(),
                limit_nanos: i64::from(limit_cents) * CENT_TO_NANOS,
                period: if period == "total" {
                    BudgetPeriod::Total
                } else {
                    BudgetPeriod::Monthly
                },
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::super::pg_test_support::*;
    use super::*;

    #[tokio::test]
    async fn resolves_a_binding_for_an_organization_scoped_secret() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let org_id = unique_id("org");
        let secret_id = unique_id("sec");
        insert_org(&pool, &org_id).await;
        insert_secret(&pool, &secret_id, &org_id, "organization", "anthropic").await;
        insert_budget(&pool, &org_id, &secret_id, 500, "monthly").await;

        let secrets = vec![db::SecretRow {
            id: secret_id.clone(),
            scope: "organization".to_string(),
            type_: "anthropic".to_string(),
            value_source: "inline".to_string(),
            encrypted_value: None,
            op_ref: None,
            host_pattern: "api.anthropic.com".to_string(),
            path_pattern: None,
            injection_config: None,
            metadata: None,
        }];

        let bindings = resolve_bindings(&pool, &org_id, &secrets, true).await;
        assert_eq!(bindings.len(), 1);
        assert_eq!(bindings[0].secret_id, secret_id);
        assert_eq!(bindings[0].subject, BudgetSubject::Org(org_id.clone()));
        assert_eq!(bindings[0].secret_type, "anthropic");
        assert_eq!(bindings[0].limit_nanos, 500 * CENT_TO_NANOS);
        assert_eq!(bindings[0].period, BudgetPeriod::Monthly);

        cleanup(&pool, &org_id, &[&secret_id]).await;
    }

    #[tokio::test]
    async fn resolves_a_binding_for_a_workspace_scoped_secret() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let org_id = unique_id("org");
        let secret_id = unique_id("sec");
        insert_org(&pool, &org_id).await;
        // A workspace-scoped secret (no workspace row needed: eligibility here
        // never consults `scope` or `workspace_id` — see the module doc).
        insert_secret(&pool, &secret_id, &org_id, "workspace", "anthropic").await;
        insert_budget(&pool, &org_id, &secret_id, 1_000, "total").await;

        let secrets = vec![db::SecretRow {
            id: secret_id.clone(),
            scope: "workspace".to_string(),
            type_: "anthropic".to_string(),
            value_source: "inline".to_string(),
            encrypted_value: None,
            op_ref: None,
            host_pattern: "api.anthropic.com".to_string(),
            path_pattern: None,
            injection_config: None,
            metadata: None,
        }];

        let bindings = resolve_bindings(&pool, &org_id, &secrets, true).await;
        assert_eq!(bindings.len(), 1);
        assert_eq!(bindings[0].period, BudgetPeriod::Total);
        assert_eq!(bindings[0].limit_nanos, 1_000 * CENT_TO_NANOS);

        cleanup(&pool, &org_id, &[&secret_id]).await;
    }

    /// Two budgeted secrets of the same type on the same host: `secrets` is
    /// passed in `proxy::connect`'s injection order (org, then workspace), and
    /// the workspace one (last = the effective, actually-injected credential
    /// under "last wins" header injection) must come FIRST in the returned
    /// bindings — `track_and_wrap` metering the first metered binding must
    /// charge the secret that was actually used, not whichever row Postgres
    /// happened to return first.
    #[tokio::test]
    async fn orders_the_effective_last_injected_secret_first() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let org_id = unique_id("org");
        let org_secret_id = unique_id("sec-org");
        let workspace_secret_id = unique_id("sec-ws");
        insert_org(&pool, &org_id).await;
        insert_secret(&pool, &org_secret_id, &org_id, "organization", "anthropic").await;
        insert_secret(
            &pool,
            &workspace_secret_id,
            &org_id,
            "workspace",
            "anthropic",
        )
        .await;
        insert_budget(&pool, &org_id, &org_secret_id, 500, "monthly").await;
        insert_budget(&pool, &org_id, &workspace_secret_id, 1_000, "monthly").await;

        let secret_row = |id: &str, scope: &str| db::SecretRow {
            id: id.to_string(),
            scope: scope.to_string(),
            type_: "anthropic".to_string(),
            value_source: "inline".to_string(),
            encrypted_value: None,
            op_ref: None,
            host_pattern: "api.anthropic.com".to_string(),
            path_pattern: None,
            injection_config: None,
            metadata: None,
        };
        // Injection order: org first, workspace last (mirrors
        // `resolve_secret_injections`'s `pool_secrets.extend(workspace_result)`).
        let secrets = vec![
            secret_row(&org_secret_id, "organization"),
            secret_row(&workspace_secret_id, "workspace"),
        ];

        let bindings = resolve_bindings(&pool, &org_id, &secrets, true).await;
        assert_eq!(bindings.len(), 2);
        assert_eq!(
            bindings[0].secret_id, workspace_secret_id,
            "the last-injected (workspace) secret's binding must come first"
        );
        assert_eq!(bindings[1].secret_id, org_secret_id);

        cleanup(&pool, &org_id, &[&org_secret_id, &workspace_secret_id]).await;
    }

    #[tokio::test]
    async fn skips_a_non_positive_limit_without_blocking_permanently() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let org_id = unique_id("org");
        let secret_id = unique_id("sec");
        insert_org(&pool, &org_id).await;
        insert_secret(&pool, &secret_id, &org_id, "organization", "anthropic").await;
        insert_budget(&pool, &org_id, &secret_id, 0, "monthly").await;

        let secrets = vec![db::SecretRow {
            id: secret_id.clone(),
            scope: "organization".to_string(),
            type_: "anthropic".to_string(),
            value_source: "inline".to_string(),
            encrypted_value: None,
            op_ref: None,
            host_pattern: "api.anthropic.com".to_string(),
            path_pattern: None,
            injection_config: None,
            metadata: None,
        }];

        let bindings = resolve_bindings(&pool, &org_id, &secrets, true).await;
        assert!(
            bindings.is_empty(),
            "a non-positive limit_cents must never produce an enforced binding"
        );

        cleanup(&pool, &org_id, &[&secret_id]).await;
    }
}
