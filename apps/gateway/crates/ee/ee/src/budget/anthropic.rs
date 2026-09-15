//! Anthropic response accumulators: SSE (streaming) and JSON (non-streaming).
//!
//! Both feed bytes incrementally as they arrive off the wire and price the
//! parsed usage only once, at `finish()`. Neither ever fabricates a charge on
//! malformed or oversized input — every failure mode here degrades to a $0
//! (or best-effort partial) charge with a warning, never an error that could
//! interrupt the response the agent is already receiving.

use tracing::warn;

use super::meter::UsageAccumulator;
use super::pricing::{cost_nanos, TokenUsage};

/// Build the accumulator for a metered Anthropic response. `is_sse` comes
/// from the response `Content-Type` (`proxy::hooks::track_and_wrap`).
#[must_use]
pub fn accumulator(is_sse: bool) -> Box<dyn UsageAccumulator> {
    if is_sse {
        Box::new(SseAccumulator::default())
    } else {
        Box::new(JsonAccumulator::default())
    }
}

/// Cap on an unterminated SSE line buffer. A line that never completes (a
/// pathological or malicious upstream) is discarded rather than growing
/// unbounded — an undercount of at most one event, not a memory leak.
const MAX_SSE_LINE_BYTES: usize = 512 * 1024;

#[derive(Default)]
struct SseAccumulator {
    line_buf: Vec<u8>,
    usage: TokenUsage,
}

impl SseAccumulator {
    fn process_line(&mut self, line: &[u8]) {
        let Some(rest) = line.strip_prefix(b"data:") else {
            return;
        };
        let rest = trim_leading_ascii_ws(rest);
        // A malformed `data:` line is ignored, not an error — the accumulator
        // never fails the response it's riding along on.
        let Ok(value) = serde_json::from_slice::<serde_json::Value>(rest) else {
            return;
        };
        let Some(event_type) = value.get("type").and_then(|v| v.as_str()) else {
            return;
        };
        match event_type {
            "message_start" => {
                let Some(message) = value.get("message") else {
                    return;
                };
                if let Some(model) = message.get("model").and_then(|v| v.as_str()) {
                    self.usage.model = Some(model.to_string());
                }
                if let Some(usage) = message.get("usage") {
                    if let Some(n) = usage.get("input_tokens").and_then(|v| v.as_u64()) {
                        self.usage.input = n;
                    }
                    if let Some(n) = usage
                        .get("cache_creation_input_tokens")
                        .and_then(|v| v.as_u64())
                    {
                        self.usage.cache_creation = n;
                    }
                    if let Some(n) = usage
                        .get("cache_read_input_tokens")
                        .and_then(|v| v.as_u64())
                    {
                        self.usage.cache_read = n;
                    }
                }
            }
            "message_delta" => {
                // Last positive wins: a trailing 0 (or absent field) must not
                // erase a genuine final count from an earlier delta.
                if let Some(n) = value
                    .get("usage")
                    .and_then(|u| u.get("output_tokens"))
                    .and_then(|v| v.as_u64())
                {
                    if n > 0 {
                        self.usage.output = n;
                    }
                }
            }
            _ => {}
        }
    }
}

fn trim_leading_ascii_ws(mut s: &[u8]) -> &[u8] {
    while let Some((&b, rest)) = s.split_first() {
        if b == b' ' || b == b'\t' {
            s = rest;
        } else {
            break;
        }
    }
    s
}

impl UsageAccumulator for SseAccumulator {
    fn feed(&mut self, chunk: &[u8]) {
        self.line_buf.extend_from_slice(chunk);
        while let Some(pos) = self.line_buf.iter().position(|&b| b == b'\n') {
            let mut line: Vec<u8> = self.line_buf.drain(..=pos).collect();
            line.pop(); // trailing '\n'
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            self.process_line(&line);
        }
        if self.line_buf.len() > MAX_SSE_LINE_BYTES {
            warn!(
                len = self.line_buf.len(),
                "budget meter: unterminated SSE line exceeded the cap; discarding"
            );
            self.line_buf.clear();
        }
    }

    fn finish(&mut self) -> i64 {
        // A stream that ends right after its final event, with no trailing
        // `\n` (the connection simply closes), would otherwise leave that
        // event sitting unprocessed in `line_buf` and lose its usage — most
        // commonly the very `message_delta` carrying `output_tokens`. `feed`
        // already enforces the cap, so whatever remains here is safe to
        // process as-is.
        if !self.line_buf.is_empty() {
            let mut line = std::mem::take(&mut self.line_buf);
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            self.process_line(&line);
        }
        cost_nanos(&self.usage)
    }
}

/// Cap on the buffered non-streaming JSON body. Exceeding it means the whole
/// response is priced at $0 (a documented undercount) rather than parsing a
/// partial body, which could misattribute usage from a truncated field.
const MAX_JSON_BYTES: usize = 256 * 1024;

#[derive(Default)]
struct JsonAccumulator {
    buf: Vec<u8>,
    truncated: bool,
}

impl UsageAccumulator for JsonAccumulator {
    fn feed(&mut self, chunk: &[u8]) {
        if self.truncated {
            return;
        }
        if self.buf.len() + chunk.len() > MAX_JSON_BYTES {
            warn!("budget meter: JSON response exceeded the buffer cap; charging $0");
            self.truncated = true;
            self.buf.clear();
            self.buf.shrink_to_fit();
            return;
        }
        self.buf.extend_from_slice(chunk);
    }

    fn finish(&mut self) -> i64 {
        if self.truncated {
            return 0;
        }
        let Ok(value) = serde_json::from_slice::<serde_json::Value>(&self.buf) else {
            warn!("budget meter: failed to parse the JSON response; charging $0");
            return 0;
        };
        let model = value
            .get("model")
            .and_then(|v| v.as_str())
            .map(str::to_string);
        let usage = value.get("usage");
        let token = |key: &str| -> u64 {
            usage
                .and_then(|u| u.get(key))
                .and_then(|v| v.as_u64())
                .unwrap_or(0)
        };
        cost_nanos(&TokenUsage {
            input: token("input_tokens"),
            output: token("output_tokens"),
            cache_creation: token("cache_creation_input_tokens"),
            cache_read: token("cache_read_input_tokens"),
            model,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sse_accumulator_reads_message_start_and_message_delta() {
        let mut acc = SseAccumulator::default();
        acc.feed(b"event: message_start\n");
        acc.feed(
            br#"data: {"type":"message_start","message":{"model":"claude-opus-4-1-20250805","usage":{"input_tokens":1000,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":1}}}"#,
        );
        acc.feed(b"\n\n");
        acc.feed(b"event: message_delta\n");
        acc.feed(br#"data: {"type":"message_delta","delta":{},"usage":{"output_tokens":100}}"#);
        acc.feed(b"\n");

        assert_eq!(acc.finish(), 7_500_000); // opus: 1000 in + 100 out.
    }

    #[test]
    fn sse_accumulator_last_positive_output_wins() {
        let mut acc = SseAccumulator::default();
        acc.feed(br#"data: {"type":"message_start","message":{"model":"claude-sonnet-4-5","usage":{"input_tokens":10}}}"#);
        acc.feed(b"\n");
        acc.feed(br#"data: {"type":"message_delta","usage":{"output_tokens":5}}"#);
        acc.feed(b"\n");
        // A trailing 0 must not erase the last genuine positive count.
        acc.feed(br#"data: {"type":"message_delta","usage":{"output_tokens":0}}"#);
        acc.feed(b"\n");

        assert_eq!(acc.usage.output, 5);
    }

    #[test]
    fn sse_accumulator_handles_split_chunks_across_feed_calls() {
        let mut acc = SseAccumulator::default();
        let line =
            br#"data: {"type":"message_start","message":{"model":"claude-haiku-4","usage":{"input_tokens":4}}}"#;
        let (head, tail) = line.split_at(20);
        acc.feed(head);
        acc.feed(tail);
        acc.feed(b"\n");
        assert_eq!(acc.usage.input, 4);
        assert_eq!(acc.usage.model.as_deref(), Some("claude-haiku-4"));
    }

    #[test]
    fn sse_accumulator_ignores_malformed_lines() {
        let mut acc = SseAccumulator::default();
        acc.feed(b"data: not json at all\n");
        acc.feed(b": a comment line, not a data line\n");
        assert_eq!(acc.finish(), 0);
    }

    #[test]
    fn sse_accumulator_discards_an_oversized_unterminated_line() {
        let mut acc = SseAccumulator::default();
        acc.feed(&vec![b'x'; MAX_SSE_LINE_BYTES + 1]);
        assert!(acc.line_buf.is_empty());
    }

    #[test]
    fn sse_accumulator_accepts_data_with_no_space_after_the_colon() {
        let mut acc = SseAccumulator::default();
        acc.feed(
            br#"data:{"type":"message_start","message":{"model":"claude-haiku-4","usage":{"input_tokens":7}}}"#,
        );
        acc.feed(b"\n");
        assert_eq!(acc.usage.input, 7);
    }

    #[test]
    fn sse_accumulator_strips_a_trailing_carriage_return() {
        let mut acc = SseAccumulator::default();
        acc.feed(
            b"data: {\"type\":\"message_start\",\"message\":{\"model\":\"claude-haiku-4\",\"usage\":{\"input_tokens\":9}}}\r\n",
        );
        assert_eq!(acc.usage.input, 9);
    }

    #[test]
    fn stream_ending_mid_line_still_prices_the_last_event() {
        let mut acc = SseAccumulator::default();
        acc.feed(
            br#"data: {"type":"message_start","message":{"model":"claude-opus-4-1","usage":{"input_tokens":1000}}}"#,
        );
        acc.feed(b"\n");
        // The stream simply ends here — no trailing '\n' after the final
        // event — the way a real connection close would arrive.
        acc.feed(br#"data: {"type":"message_delta","usage":{"output_tokens":100}}"#);
        assert_eq!(acc.finish(), 7_500_000); // opus: 1000 in + 100 out.
    }

    #[test]
    fn json_accumulator_parses_a_full_non_stream_body() {
        let mut acc = JsonAccumulator::default();
        acc.feed(
            br#"{"id":"msg_1","model":"claude-sonnet-4-5-20250929","usage":{"input_tokens":1000,"output_tokens":100}}"#,
        );
        assert_eq!(acc.finish(), 4_500_000);
    }

    #[test]
    fn json_accumulator_handles_split_chunks() {
        let body =
            br#"{"model":"claude-opus-4-1","usage":{"input_tokens":1000,"output_tokens":100}}"#;
        let (head, tail) = body.split_at(30);
        let mut acc = JsonAccumulator::default();
        acc.feed(head);
        acc.feed(tail);
        assert_eq!(acc.finish(), 7_500_000);
    }

    #[test]
    fn json_accumulator_missing_usage_fields_are_zero() {
        let mut acc = JsonAccumulator::default();
        acc.feed(br#"{"id":"batch_1","model":"claude-opus-4-1"}"#);
        assert_eq!(acc.finish(), 0);
    }

    #[test]
    fn json_accumulator_over_cap_charges_zero() {
        let mut acc = JsonAccumulator::default();
        acc.feed(&vec![b'{'; MAX_JSON_BYTES + 1]);
        assert_eq!(acc.finish(), 0);
    }

    #[test]
    fn json_accumulator_unparseable_body_charges_zero() {
        let mut acc = JsonAccumulator::default();
        acc.feed(b"not json");
        assert_eq!(acc.finish(), 0);
    }
}
