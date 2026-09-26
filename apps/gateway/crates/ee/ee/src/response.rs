//! Agent-facing error bodies produced by the licensed features. These are
//! "tiny and Apache-shaped" (`docs/upstream-sync/v2-migration/phase0-plan.md`
//! WP2) — pure JSON builders, no reason to stub them; implemented verbatim
//! from `docs/upstream-sync/v2-migration/gateway-ee-behaviour.md` §7.
//!
//! All five: JSON body, `content-type: application/json`,
//! `x-should-retry: false`.

use http_body_util::{Either, Full};
use hyper::body::Bytes;
use hyper::header::HeaderValue;
use hyper::{Response, StatusCode};

use crate::budget::{BudgetBinding, BudgetPeriod};
use crate::platform_llm::PLATFORM_SECRET_ID;

type ForwardBody = context::ForwardResponseBody;

fn json_response(status: StatusCode, body: serde_json::Value) -> Response<ForwardBody> {
    let bytes = Bytes::from(body.to_string());
    let mut response = Response::new(Either::Left(Full::new(bytes)));
    *response.status_mut() = status;
    response.headers_mut().insert(
        hyper::header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    response
        .headers_mut()
        .insert("x-should-retry", HeaderValue::from_static("false"));
    response
}

/// 429 — a Cloud free-plan integration-call quota was exceeded. Only
/// reachable when `Edition::Cloud` and plan `"free"`
/// (`proxy::hooks::call_limit_for_plan`) — dead on this onprem-only fork, but
/// kept fully implemented since the call site (`proxy::hooks`) is unconditional.
#[must_use]
pub fn quota_exceeded(limit: u64, org_id: Option<&str>) -> Response<ForwardBody> {
    let base = context::dashboard_url();
    let upgrade_url = match org_id {
        Some(oid) => format!("{base}/org/{oid}/billing"),
        None => format!("{base}/billing"),
    };
    json_response(
        StatusCode::TOO_MANY_REQUESTS,
        serde_json::json!({
            "error": "quota_exceeded",
            "message": format!(
                "Your plan allows {limit} integration calls per month. Upgrade to Pro or Team for unlimited calls."
            ),
            "limit": limit,
            "upgrade_url": upgrade_url,
        }),
    )
}

/// 403 — a spend budget on a secret has been reached. `error` distinguishes
/// the (Cloud-only, unreachable in this build) platform trial-credit arm
/// from an ordinary org/workspace budget by `secret_id`; the org arm is the
/// only one this fork ever renders in practice, but both are implemented in
/// full since `binding.secret_id` decides at call time, not at compile time.
#[must_use]
pub fn budget_exceeded(
    binding: &BudgetBinding,
    workspace_id: Option<&str>,
) -> Response<ForwardBody> {
    let base = context::dashboard_url();
    let add_key_url = context::scoped_url(base, "/connections/llms", workspace_id);
    let limit_usd = binding.limit_nanos as f64 / 1_000_000_000.0;
    let period = match binding.period {
        BudgetPeriod::Monthly => "monthly",
        BudgetPeriod::Total => "total",
    };

    if binding.secret_id == PLATFORM_SECRET_ID {
        return json_response(
            StatusCode::FORBIDDEN,
            serde_json::json!({
                "error": "trial_credit_exhausted",
                "message": format!(
                    "Your free OneCLI trial credit (${limit_usd:.2}) is used up. Add your own Anthropic API key in the OneCLI dashboard to keep going: {add_key_url}"
                ),
                "limit_usd": limit_usd,
                "period": period,
                "add_key_url": add_key_url,
            }),
        );
    }

    let period_phrase = match binding.period {
        BudgetPeriod::Monthly => "this month",
        BudgetPeriod::Total => "in total",
    };
    json_response(
        StatusCode::FORBIDDEN,
        serde_json::json!({
            "error": "budget_exceeded",
            "message": format!(
                "This organization's spend budget for the {secret_type} key (${limit_usd:.2} {period_phrase}) has been reached, so the key is paused. The user can set their own key in the OneCLI dashboard to keep going: {add_key_url}",
                secret_type = binding.secret_type,
            ),
            "limit_usd": limit_usd,
            "period": period,
            "add_key_url": add_key_url,
        }),
    )
}

/// 403 — the requested provider is not available to this workspace under a
/// restricted app-availability policy. Reachable only if `principals`'s
/// availability loader is ever flipped to a restricting mode (TRIM in this
/// build — see `principals::load_available_apps`).
#[must_use]
pub fn app_unavailable(
    provider: &str,
    method: &str,
    path: &str,
    host: &str,
) -> Response<ForwardBody> {
    let host = common::util::strip_port(host);
    json_response(
        StatusCode::FORBIDDEN,
        serde_json::json!({
            "error": "app_unavailable",
            "message": format!(
                "The \"{provider}\" app is not available to this workspace. {method} {host}{path} was blocked. An organization admin can grant access on the App Availability page."
            ),
            "provider": provider,
            "method": method,
            "host": host,
            "path": path,
        }),
    )
}

/// 403 — a granular resource guard (Dropbox folder policy, GitHub App
/// repository scope) denied the request.
#[must_use]
pub fn forbidden_resource(reason: &str, allowed: &[String]) -> Response<ForwardBody> {
    json_response(
        StatusCode::FORBIDDEN,
        serde_json::json!({
            "error": "resource_access_denied",
            "message": format!(
                "This agent is restricted to: {allowed}. The requested resource is outside its allowed scope — use a location inside one of those.",
                allowed = allowed.join(", "),
            ),
            "allowed": allowed,
            "detail": reason,
        }),
    )
}

/// 403 — the composed resource scope (org boundary ∩ workspace selection) is
/// empty: nothing can ever be in scope, so the request is refused before any
/// credential is materialized or served.
#[must_use]
pub fn forbidden_empty_scope() -> Response<ForwardBody> {
    json_response(
        StatusCode::FORBIDDEN,
        serde_json::json!({
            "error": "resource_access_denied",
            "message": "This agent's resource scope is empty: the organization's allowed resources and this workspace's selection do not overlap, so the credential can reach nothing. Ask an administrator to widen the scope.",
            "allowed": Vec::<String>::new(),
            "detail": "empty resource scope",
        }),
    )
}
