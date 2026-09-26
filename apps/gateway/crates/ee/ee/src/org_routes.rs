//! `GET /v1/org/approvals/pending` — long-poll for approvals pending anywhere
//! in the organization (a superset of the free per-workspace poll).
//!
//! Mounted unconditionally in every edition. The licensed original's only
//! entitlement-specific behavior was an `enterprise_license_required` 403
//! gate in front of this handler; per plan.md ("`org_routes`: KEEP minus the
//! licence 403") that gate is simply gone — entitlement is always on in this
//! fork, so the route now behaves exactly as the licensed arm always did.

use std::collections::HashSet;
use std::time::Duration;

use axum::extract::{Query, State};
use axum::response::IntoResponse;
use axum::routing::get;
use axum::{Json, Router};
use hyper::StatusCode;
use tracing::{info, info_span, Instrument};

use approval::{pending_approval_row, PendingParams, APPROVAL_TIMEOUT_SECS};
use context::auth::OrgAuthUser;
use context::GatewayState;

pub fn mount(router: Router<GatewayState>) -> Router<GatewayState> {
    router.route("/v1/org/approvals/pending", get(get_org_pending_approvals))
}

async fn get_org_pending_approvals(
    auth: OrgAuthUser,
    State(state): State<GatewayState>,
    Query(params): Query<PendingParams>,
) -> impl IntoResponse {
    // A workspace-scoped key, or any browser session, carries no
    // organization scope — this route needs an org-scoped `oc_org_` API key.
    let Some(org_id) = auth.organization_id else {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({"error": "organization_scope_required"})),
        )
            .into_response();
    };

    let span = info_span!(
        "org_approval_poll",
        organization_id = %org_id,
        auth_method = %auth.auth_method,
    );
    async move {
        let exclude: HashSet<&str> = params
            .exclude
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .collect();

        let mut pending = state.approval_store.list_pending_for_org(&org_id).await;
        pending.retain(|a| !exclude.contains(a.id.as_str()));

        if pending.is_empty() {
            let mut shutdown_signal = shutdown::subscribe();
            // Answer "nothing pending" at once on shutdown rather than
            // holding a connection open through the drain window — mirrors
            // the free per-workspace poll (`server::get_pending_approvals`).
            let got_new = tokio::select! {
                got_new = state
                    .approval_store
                    .wait_for_new_for_org(&org_id, Duration::from_secs(30)) => got_new,
                _ = shutdown_signal.wait() => false,
            };
            if got_new {
                let mut fresh = state.approval_store.list_pending_for_org(&org_id).await;
                fresh.retain(|a| !exclude.contains(a.id.as_str()));
                pending = fresh;
            }
        }

        info!(count = pending.len(), "org approval poll completed");

        Json(serde_json::json!({
            "requests": pending.iter().map(pending_approval_row).collect::<Vec<_>>(),
            "timeoutSeconds": APPROVAL_TIMEOUT_SECS,
        }))
        .into_response()
    }
    .instrument(span)
    .await
}
