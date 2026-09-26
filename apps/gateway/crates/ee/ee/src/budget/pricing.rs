//! Static Anthropic pricing table and the nano-dollar cost calculation.
//!
//! Nano-dollars per token, by model family (substring match on the wire model
//! id — date suffixes tolerated): matches `gateway-ee-behaviour.md` §4.6
//! exactly. Equivalent to $/MTok: Opus 5/25/6.25/0.5, Sonnet 3/15/3.75/0.3,
//! Haiku 1/5/1.25/0.1. The 1-hour cache-write tier (2x input) is lumped into
//! `cache_creation` and therefore undercharged — documented and accepted.

use tracing::warn;

/// Parsed token usage for one metered response, already split into the four
/// billable categories.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct TokenUsage {
    pub input: u64,
    pub output: u64,
    /// Anthropic `cache_creation_input_tokens` (5-min tier billed here).
    pub cache_creation: u64,
    /// Anthropic `cache_read_input_tokens`.
    pub cache_read: u64,
    pub model: Option<String>,
}

struct Rate {
    input: i64,
    output: i64,
    cache_write: i64,
    cache_read: i64,
}

const OPUS: Rate = Rate {
    input: 5_000,
    output: 25_000,
    cache_write: 6_250,
    cache_read: 500,
};
const SONNET: Rate = Rate {
    input: 3_000,
    output: 15_000,
    cache_write: 3_750,
    cache_read: 300,
};
const HAIKU: Rate = Rate {
    input: 1_000,
    output: 5_000,
    cache_write: 1_250,
    cache_read: 100,
};

/// Longest-prefix intent doesn't apply here — these three substrings never
/// overlap in a real model id — so a plain substring scan is enough. Unknown
/// or missing model prices as Opus (fail-safe toward enforcement: a spend cap
/// that silently under-prices an unrecognized model is worse than one that
/// overcharges it) and warns once per call.
fn rate_for_model(model: Option<&str>) -> Rate {
    match model {
        Some(m) if m.contains("opus") => OPUS,
        Some(m) if m.contains("sonnet") => SONNET,
        Some(m) if m.contains("haiku") => HAIKU,
        Some(m) => {
            warn!(model = m, "budget: unknown model; pricing as opus");
            OPUS
        }
        None => {
            warn!("budget: missing model; pricing as opus");
            OPUS
        }
    }
}

/// `tokens * nanos_per_token`, computed in `i128` and clamped to `i64` so a
/// pathological token count can never wrap rather than saturate.
fn mul_nanos(tokens: u64, per_token: i64) -> i64 {
    let product = i128::from(tokens) * i128::from(per_token);
    product.clamp(i128::from(i64::MIN), i128::from(i64::MAX)) as i64
}

/// Price a usage into nano-dollars. All-zero usage (a `models.list` /
/// `count_tokens` body, or a truly empty response) → `0` with no warning and
/// no rate lookup — pricing an empty response as Opus would spuriously warn
/// on every such call. Saturating arithmetic throughout; the final sum
/// clamps to `i64::MAX`.
#[must_use]
pub fn cost_nanos(usage: &TokenUsage) -> i64 {
    if usage.input == 0 && usage.output == 0 && usage.cache_creation == 0 && usage.cache_read == 0 {
        return 0;
    }
    let rate = rate_for_model(usage.model.as_deref());
    mul_nanos(usage.input, rate.input)
        .saturating_add(mul_nanos(usage.output, rate.output))
        .saturating_add(mul_nanos(usage.cache_creation, rate.cache_write))
        .saturating_add(mul_nanos(usage.cache_read, rate.cache_read))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn usage(
        model: &str,
        input: u64,
        output: u64,
        cache_creation: u64,
        cache_read: u64,
    ) -> TokenUsage {
        TokenUsage {
            input,
            output,
            cache_creation,
            cache_read,
            model: Some(model.to_string()),
        }
    }

    #[test]
    fn opus_in_and_out() {
        assert_eq!(
            cost_nanos(&usage("claude-opus-4-1-20250805", 1_000, 100, 0, 0)),
            7_500_000
        );
    }

    #[test]
    fn sonnet_in_and_out() {
        assert_eq!(
            cost_nanos(&usage("claude-sonnet-4-5-20250929", 1_000, 100, 0, 0)),
            4_500_000
        );
    }

    #[test]
    fn haiku_in_and_out() {
        assert_eq!(
            cost_nanos(&usage("claude-haiku-4-20250101", 1_000, 100, 0, 0)),
            1_500_000
        );
    }

    #[test]
    fn opus_cache_write_and_read() {
        assert_eq!(
            cost_nanos(&usage("claude-opus-4-1", 0, 0, 1_000, 1_000)),
            6_750_000
        );
    }

    #[test]
    fn unknown_model_prices_as_opus() {
        let unknown = usage("some-future-model-9", 1_000, 100, 0, 0);
        let opus = usage("claude-opus-4-1", 1_000, 100, 0, 0);
        assert_eq!(cost_nanos(&unknown), cost_nanos(&opus));
    }

    #[test]
    fn missing_model_prices_as_opus() {
        let missing = TokenUsage {
            input: 1_000,
            output: 100,
            cache_creation: 0,
            cache_read: 0,
            model: None,
        };
        assert_eq!(cost_nanos(&missing), 7_500_000);
    }

    #[test]
    fn all_zero_usage_is_free_regardless_of_model() {
        assert_eq!(cost_nanos(&TokenUsage::default()), 0);
        let missing_but_zero = TokenUsage {
            model: None,
            ..Default::default()
        };
        assert_eq!(cost_nanos(&missing_but_zero), 0);
    }

    #[test]
    fn saturates_instead_of_overflowing() {
        let extreme = usage("claude-opus-4-1", u64::MAX, u64::MAX, u64::MAX, u64::MAX);
        assert_eq!(cost_nanos(&extreme), i64::MAX);
    }
}
