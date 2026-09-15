//! The metered response stream wrapper.
//!
//! `proxy::hooks::track_and_wrap` calls [`wrap_metered`] for a 2xx response on
//! a binding whose secret type [`has_meter`]. The returned stream passes
//! bytes through unchanged while feeding them to a [`UsageAccumulator`] (the
//! Anthropic SSE/JSON parsers in `super::anthropic`), and fires exactly one
//! `telemetry::on_request` — carrying the priced `BudgetCharge` — at end of
//! stream or on an early drop (client disconnect / abort). The `Option::take`
//! guard is what makes "exactly once" hold across both exit paths.

use std::pin::Pin;
use std::task::{Context as TaskContext, Poll};

use futures_util::Stream;
use hyper::body::{Bytes, Frame};
use telemetry::core::{BudgetCharge, RequestMeta};

use super::anthropic;
use super::spend::period_key;
use super::BudgetBinding;

/// Feeds response bytes as they arrive and, at stream end, reports the priced
/// cost in nano-dollars. Implementations live in `super::anthropic` (the only
/// metered provider in this phase — see [`has_meter`]).
pub trait UsageAccumulator: Send {
    fn feed(&mut self, chunk: &[u8]);
    fn finish(&mut self) -> i64;
}

/// Whether a secret type has a meter (and therefore a price table) — the only
/// metered type in this phase is `anthropic` (OpenAI metering is an explicit
/// Phase 1 follow-up, not built here; see `budget.rs` module doc and
/// `docs/upstream-sync/v2-migration/phase1-plan.md` vetting note 1). Any other
/// type falls through `track_and_wrap` unmetered: the gate above still
/// enforces prior spend, but a response body from it is never parsed or
/// priced.
#[must_use]
pub fn has_meter(secret_type: &str) -> bool {
    secret_type == "anthropic"
}

struct MeteringStream {
    inner: Pin<Box<dyn Stream<Item = Result<Bytes, reqwest::Error>> + Send>>,
    acc: Box<dyn UsageAccumulator>,
    // `Option` so the emission happens exactly once regardless of whether the
    // stream is polled to completion or dropped early.
    meta: Option<RequestMeta>,
    secret_id: String,
    subject: String,
    period_key: String,
}

impl MeteringStream {
    fn emit_once(&mut self) {
        if let Some(meta) = self.meta.take() {
            let cost_nanos = self.acc.finish();
            telemetry::on_request(meta.into_event(Some(BudgetCharge {
                secret_id: self.secret_id.clone(),
                subject: self.subject.clone(),
                period_key: self.period_key.clone(),
                cost_nanos,
            })));
        }
    }
}

impl Stream for MeteringStream {
    type Item = Result<Frame<Bytes>, reqwest::Error>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut TaskContext<'_>) -> Poll<Option<Self::Item>> {
        match self.inner.as_mut().poll_next(cx) {
            Poll::Ready(Some(Ok(bytes))) => {
                self.acc.feed(&bytes);
                Poll::Ready(Some(Ok(Frame::data(bytes))))
            }
            // Errors mid-stream pass through unchanged; the charge still
            // fires (on the next poll's `None`, or on drop) for whatever was
            // parsed before the error.
            Poll::Ready(Some(Err(err))) => Poll::Ready(Some(Err(err))),
            Poll::Ready(None) => {
                self.emit_once();
                Poll::Ready(None)
            }
            Poll::Pending => Poll::Pending,
        }
    }
}

impl Drop for MeteringStream {
    fn drop(&mut self) {
        self.emit_once();
    }
}

/// Wrap a 2xx upstream stream so its bytes pass through unchanged while
/// metering usage and firing the one `telemetry::on_request` emission
/// `track_and_wrap` skips when it hands back a metered stream (the free path
/// fires it itself only when NOT wrapping). See `MeteringStream`.
#[must_use]
pub fn wrap_metered(
    binding: &BudgetBinding,
    meta: RequestMeta,
    is_sse: bool,
    stream: Pin<Box<dyn Stream<Item = Result<Bytes, reqwest::Error>> + Send>>,
) -> context::BodyStream {
    Box::pin(MeteringStream {
        inner: stream,
        acc: anthropic::accumulator(is_sse),
        meta: Some(meta),
        secret_id: binding.secret_id.clone(),
        subject: binding.subject.to_string(),
        period_key: period_key(binding.period),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn has_meter_is_anthropic_only() {
        assert!(has_meter("anthropic"));
        assert!(!has_meter("openai"));
        assert!(!has_meter("generic"));
        assert!(!has_meter(""));
    }
}
