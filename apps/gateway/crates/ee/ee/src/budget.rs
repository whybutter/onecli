//! Spend budgets on org/workspace secrets.
//!
//! Phase 0 posture (`docs/upstream-sync/v2-migration/phase0-plan.md` WP2):
//! the wire-facing TYPES are real (they are cached inside `ConnectResponse`,
//! so their shape is load-bearing even though nothing produces a binding
//! yet), but the actual eligibility/spend LOGIC is dormant — `resolve_bindings`
//! always returns empty, so nothing downstream (`has_meter`, `is_over_budget`,
//! `wrap_metered`) ever fires in practice. Phase 1 rewrites `resolve_bindings`
//! for the fork's own org/workspace secret eligibility rule.

use std::pin::Pin;
use std::task::{Context as TaskContext, Poll};

use futures_util::Stream;
use hyper::body::{Bytes, Frame};

/// How often a budget resets. Serialized lowercase — this value is part of
/// the cached `ConnectResponse` wire shape (`connect.rs`), so the encoding is
/// load-bearing even though nothing produces a non-empty binding yet.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BudgetPeriod {
    Monthly,
    Total,
}

/// Who a budget's spend is attributed to. Encoded as a single prefixed string
/// (`org:<id>` / `user:<id>`) on the wire — this is also the shape stored in
/// the `budget_spends.organization_id` column upstream, so the prefix rule is
/// load-bearing, not cosmetic.
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

/// Resolve which of the host-filtered secrets carry a spend budget. Dormant
/// in this build: nothing yet defines org/workspace budget eligibility (that
/// is Phase 1's rewrite), so this always returns empty and the rest of the
/// budget pipeline (`has_meter`, `is_over_budget`, `wrap_metered`) never
/// fires. Keeping the real generic signature (rather than a fixed
/// `&[db::SecretRow]`) matches the licensed original and costs nothing.
pub async fn resolve_bindings<S: BudgetSecret>(
    _pool: &sqlx::PgPool,
    _org_id: &str,
    _secrets: &[S],
    _entitled: bool,
) -> Vec<BudgetBinding> {
    Vec::new()
}

/// Whether a secret type is metered (usage-priced) rather than a flat
/// pass/fail budget. Always false in this build — no metered secret type is
/// defined yet, so `budget::wrap_metered` never gets called from
/// `proxy::hooks::track_and_wrap`.
#[must_use]
pub fn has_meter(_secret_type: &str) -> bool {
    false
}

/// Whether a binding's spend has crossed its limit. Always false: with
/// `resolve_bindings` always empty, this is never invoked on the request
/// path today, but it is still called per-binding by `proxy::hooks::pre_forward`
/// so the signature (and a safe default) must exist.
pub async fn is_over_budget(
    _cache: &dyn cache::CacheStore,
    _pool: &sqlx::PgPool,
    _binding: &BudgetBinding,
) -> bool {
    false
}

/// Passthrough stream wrapper that preserves the free path's telemetry
/// invariant: `proxy::hooks::track_and_wrap` emits `telemetry::on_request`
/// itself when it does NOT wrap the stream, so the ONE place that emits when
/// a metered binding exists is this wrapper — it must fire exactly once, at
/// end of stream (or on an early drop), with no charge (unreachable today
/// since `has_meter` is always false, but wired so Phase 1 only has to add
/// pricing here, not re-derive this contract).
struct MeteredPassthrough {
    inner: Pin<Box<dyn Stream<Item = Result<Bytes, reqwest::Error>> + Send>>,
    // `Option` so the emission happens exactly once regardless of whether the
    // stream is polled to completion or dropped early.
    meta: Option<telemetry::core::RequestMeta>,
}

impl MeteredPassthrough {
    fn emit_once(&mut self) {
        if let Some(meta) = self.meta.take() {
            telemetry::on_request(meta.into_event(None));
        }
    }
}

impl Stream for MeteredPassthrough {
    type Item = Result<Frame<Bytes>, reqwest::Error>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut TaskContext<'_>) -> Poll<Option<Self::Item>> {
        match self.inner.as_mut().poll_next(cx) {
            Poll::Ready(Some(Ok(bytes))) => Poll::Ready(Some(Ok(Frame::data(bytes)))),
            Poll::Ready(Some(Err(err))) => Poll::Ready(Some(Err(err))),
            Poll::Ready(None) => {
                self.emit_once();
                Poll::Ready(None)
            }
            Poll::Pending => Poll::Pending,
        }
    }
}

impl Drop for MeteredPassthrough {
    fn drop(&mut self) {
        self.emit_once();
    }
}

/// Wrap an upstream response stream so its bytes pass through unchanged while
/// guaranteeing the one `telemetry::on_request` emission `track_and_wrap`
/// would otherwise skip for a metered binding. See `MeteredPassthrough`.
#[must_use]
pub fn wrap_metered(
    _binding: &BudgetBinding,
    meta: telemetry::core::RequestMeta,
    _is_sse: bool,
    stream: Pin<Box<dyn Stream<Item = Result<Bytes, reqwest::Error>> + Send>>,
) -> context::BodyStream {
    Box::pin(MeteredPassthrough {
        inner: stream,
        meta: Some(meta),
    })
}

/// Installed unconditionally at startup (`wiring.rs`, before `telemetry::init`)
/// so `telemetry::flush_budget` never warns about a missing sink. A no-op here
/// because `resolve_bindings` never produces a binding to spend against in
/// this build.
pub struct BudgetSpendSink;

#[async_trait::async_trait]
impl telemetry::SpendSink for BudgetSpendSink {
    async fn add_spend(
        &self,
        _cache: &dyn cache::CacheStore,
        _pool: &sqlx::PgPool,
        secret_id: &str,
        subject: &str,
        period_key: &str,
        nanos: i64,
    ) {
        tracing::debug!(
            secret_id,
            subject,
            period_key,
            nanos,
            "budget spend sink is a no-op in this build"
        );
    }
}
