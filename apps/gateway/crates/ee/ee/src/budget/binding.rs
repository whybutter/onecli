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

    let type_by_id: HashMap<&str, &str> =
        secrets.iter().map(|s| (s.id(), s.secret_type())).collect();

    rows.into_iter()
        .filter_map(|(secret_id, limit_cents, period)| {
            if limit_cents <= 0 {
                warn!(
                    secret_id,
                    limit_cents, "budget: non-positive limit; skipping"
                );
                return None;
            }
            let secret_type = (*type_by_id.get(secret_id.as_str())?).to_string();
            Some(BudgetBinding {
                secret_id,
                subject: BudgetSubject::Org(org_id.to_string()),
                secret_type,
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
