//! Body/header condition matching and the request-body buffer that feeds it.
//!
//! A rule's `conditions` JSON (validated server-side, but re-validated here
//! with `deny_unknown_fields`) is an array of `{target, operator, value?,
//! key?}` conditions that further narrow when a rule applies: every condition
//! must hold (AND). Two targets:
//!
//! - `body`: a raw byte-level match over the buffered request body
//!   (`contains` / `equals` / `regex` via `regex::bytes` — linear-time, no
//!   ReDoS, no lossy UTF-8 conversion so a binary body can't dodge a needle).
//! - `header`: matched against the request headers. Header NAMES are
//!   case-insensitive (RFC 9110, free with `HeaderMap`); header VALUES are
//!   compared case-sensitively on raw bytes (`(?i)` regex serves the
//!   case-insensitive cases); any value of a multi-value header satisfies the
//!   condition. `exists` (header-only) needs at least one value present.
//!
//! ## Divergence from the ported matcher: body `contains` is case-insensitive
//!
//! This module is a port of the fork's `condition_match.rs` (byte-exact
//! everywhere). One deliberate behaviour change survives the port: `body`
//! `contains` folds ASCII case on both sides before searching (`header`
//! `contains`, and every `equals`/`regex` on any target, stay byte-exact —
//! `regex`'s own `(?i)` is the case-insensitive escape hatch there).
//! Upstream's insensitive body match is the safer default for Block rules (an
//! agent cannot dodge a body block by changing case) and is the behaviour
//! existing policies already assume. Folding is done over raw BYTES
//! (`u8::to_ascii_lowercase`), never through a lossy UTF-8 round-trip, so the
//! "no lossy UTF-8" property of the port holds for binary bodies too.
//!
//! ## Failure law (SECURITY)
//!
//! A condition that cannot be evaluated — malformed JSON, unknown
//! target/operator, missing required value/key, an uncompilable/oversized
//! regex, an invalid header name, or a body that exceeded the buffer cap —
//! must never weaken enforcement: the rule MATCHES if it is a Block rule
//! (over-block, fail-closed) and does NOT match otherwise (an Allow-family
//! rule falls through to the next rule / the Default Rule instead of silently
//! widening). The v2 engine routes its rules through here via pseudo-rules
//! that carry the owning rule's Block/Allow polarity for exactly this reason
//! (see `policy_engine::evaluate`'s `polarity_of`).
//!
//! ## Truncated bodies
//!
//! A body over the buffer cap (`ConditionBody::Truncated`) is evaluated on
//! its observed PREFIX only:
//! - `contains` / `regex`: a hit inside the prefix is still a definite
//!   Match (the value assuredly occurs, wherever the rest of the body is);
//!   a miss is UNKNOWN (the value may sit past the cap) and resolves through
//!   the failure law above.
//! - `equals`: always Invalid on a truncated body — the full body is by
//!   definition longer than the observed prefix, so equality can never be
//!   soundly decided either way from a prefix alone.
//!
//! A rule's `conditions` may also be a JSON OBJECT — a connection target's
//! granular session policy (`{repositories: […]}` / `{folders: […]}`), not a
//! behavioral condition. Those are vacuous here (`granular_access`'s
//! concern), matching the server-side `isSessionPolicy` discriminator.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use futures_util::{Stream, StreamExt};
use http_body_util::BodyDataStream;
use hyper::header::{HeaderName, HeaderValue};
use tracing::{debug, warn};

use crate::{PolicyAction, PolicyRule};

/// Default cap on the buffered body prefix. Sized above typical LLM request
/// bodies (the traffic #985 pulled into this path peaks around 32 KB; agent
/// prompts run larger) so the fail-closed truncation arm is rare, not routine.
const DEFAULT_CONDITION_BODY_BUFFER: usize = 256 * 1024; // 256 KB

/// Operator override for the buffer cap, clamped to [`MIN_CONDITION_BODY_BUFFER`,
/// `MAX_CONDITION_BODY_BUFFER`]. The buffer is per in-flight request, so the
/// ceiling bounds worst-case gateway memory.
const CONDITION_BODY_BUFFER_ENV: &str = "ONECLI_CONDITION_BODY_BUFFER_BYTES";
const MIN_CONDITION_BODY_BUFFER: usize = 4 * 1024; // 4 KB
const MAX_CONDITION_BODY_BUFFER: usize = 8 * 1024 * 1024; // 8 MB

/// The effective buffer cap: `ONECLI_CONDITION_BODY_BUFFER_BYTES` clamped to
/// the [4 KB, 8 MB] window, else the 256 KB default. Read once (`OnceLock`),
/// like the gateway's other env-derived config.
fn condition_body_buffer_limit() -> usize {
    static LIMIT: OnceLock<usize> = OnceLock::new();
    *LIMIT.get_or_init(|| resolve_buffer_limit(std::env::var(CONDITION_BODY_BUFFER_ENV).ok()))
}

/// Pure resolver behind [`condition_body_buffer_limit`], split out so the
/// clamp law is unit-testable without touching process env. Unparsable or
/// absent → the default; out-of-window → clamped (with a warn), so a
/// misconfigured operator value can neither disable buffering (a 0 would
/// truncate everything → mass fail-closed blocking) nor balloon per-request
/// memory unboundedly.
fn resolve_buffer_limit(raw: Option<String>) -> usize {
    match raw.and_then(|v| v.trim().parse::<usize>().ok()) {
        Some(v) => {
            let clamped = v.clamp(MIN_CONDITION_BODY_BUFFER, MAX_CONDITION_BODY_BUFFER);
            if clamped != v {
                warn!(
                    requested = v,
                    clamped,
                    "{CONDITION_BODY_BUFFER_ENV} outside [{MIN_CONDITION_BODY_BUFFER}, {MAX_CONDITION_BODY_BUFFER}]; clamped"
                );
            }
            clamped
        }
        None => DEFAULT_CONDITION_BODY_BUFFER,
    }
}

/// The request body as condition matching sees it. `Truncated` carries only a
/// prefix — bytes past the buffer cap were never observed, and every consumer
/// must resolve that doubt fail-closed (restrictive rules match, permissive
/// rules don't, GraphQL classifies as mutation).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConditionBody<'a> {
    /// No body was buffered: either the request has no body-needing rule
    /// (`needs_body_buffer` returned false — its contract is to be a strict
    /// superset of "some rule inspects this body") or the transport carries no
    /// body (e.g. a WebSocket upgrade).
    None,
    /// The complete request body (possibly empty).
    Full(&'a [u8]),
    /// A prefix of the body; the rest exceeded the buffer cap.
    Truncated(&'a [u8]),
}

impl<'a> ConditionBody<'a> {
    /// The observed bytes, if any — the full body or the truncated prefix.
    pub fn bytes(&self) -> Option<&'a [u8]> {
        match self {
            ConditionBody::None => None,
            ConditionBody::Full(b) | ConditionBody::Truncated(b) => Some(b),
        }
    }

    pub fn is_truncated(&self) -> bool {
        matches!(self, ConditionBody::Truncated(_))
    }

    /// View a buffered body (or its absence) as a `ConditionBody`.
    pub fn from_buffered(buffered: Option<&'a BufferedBody>) -> Self {
        match buffered {
            None => ConditionBody::None,
            Some(b) if b.truncated => ConditionBody::Truncated(&b.bytes),
            Some(b) => ConditionBody::Full(&b.bytes),
        }
    }
}

/// A buffered request-body prefix plus whether the body outran the cap.
/// Produced by [`prepare_body`]; viewed by the matchers via
/// [`ConditionBody::from_buffered`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BufferedBody {
    pub bytes: Vec<u8>,
    pub truncated: bool,
}

// ── Condition shape ────────────────────────────────────────────────────

/// One decoded behavioral condition (the server-validated `RuleCondition`
/// shape). Unknown FIELDS fail to decode (`deny_unknown_fields`) and unknown
/// target/operator VALUES decode but evaluate to `Invalid` — both route
/// through the fail-closed law, so a NEWER authoring surface (say, a future
/// `negate` flag) can never silently widen an older gateway.
#[derive(Debug, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct RuleCondition {
    target: String,
    operator: String,
    #[serde(default)]
    value: Option<String>,
    #[serde(default)]
    key: Option<String>,
}

/// Three-state condition evaluation. `Invalid` = unevaluable, routed through
/// the failure law.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CondEval {
    Match,
    NoMatch,
    Invalid,
}

/// The decoded shape of a rule's `conditions` JSON.
enum DecodedConditions {
    /// None / session-policy object / empty array → no behavioral conditions.
    Vacuous,
    /// A behavioral array; each element decoded independently so one malformed
    /// element poisons only itself (→ `Invalid`), not its siblings.
    Behavioral(Vec<Result<RuleCondition, ()>>),
}

fn decode_conditions(raw: &Option<serde_json::Value>) -> DecodedConditions {
    match raw {
        None => DecodedConditions::Vacuous,
        // An object is a connection target's granular session policy
        // (`repositories`/`folders`) — scoping, not a behavioral condition.
        Some(serde_json::Value::Object(_)) => DecodedConditions::Vacuous,
        Some(serde_json::Value::Array(items)) if items.is_empty() => DecodedConditions::Vacuous,
        Some(serde_json::Value::Array(items)) => DecodedConditions::Behavioral(
            items
                .iter()
                .map(|item| serde_json::from_value::<RuleCondition>(item.clone()).map_err(|_| ()))
                .collect(),
        ),
        // Any other JSON shape is malformed → one unevaluable condition.
        Some(_) => DecodedConditions::Behavioral(vec![Err(())]),
    }
}

// ── Evaluation ──────────────────────────────────────────────────────────

/// Byte-substring search (an empty needle matches anything). Linear-time
/// (`memchr::memmem`) — the haystack is an attacker-controlled request body,
/// so a naive O(haystack × needle) scan would be a cheap CPU-DoS amplifier.
fn contains_bytes(haystack: &[u8], needle: &[u8]) -> bool {
    memchr::memmem::find(haystack, needle).is_some()
}

/// ASCII-only case fold of `contains_bytes`, for `body` targets only (see the
/// module doc's divergence note). Folds both sides over raw bytes — never a
/// lossy UTF-8 round-trip — so a binary/non-ASCII body still gets a correct,
/// linear-time substring search over the folded bytes.
fn contains_bytes_ascii_ci(haystack: &[u8], needle: &[u8]) -> bool {
    let folded_haystack: Vec<u8> = haystack.iter().map(u8::to_ascii_lowercase).collect();
    let folded_needle: Vec<u8> = needle.iter().map(u8::to_ascii_lowercase).collect();
    contains_bytes(&folded_haystack, &folded_needle)
}

/// Compiled-program cap per pattern (1 MiB — ample for the API's 1000-char
/// patterns). The crate default is 10 MiB, which would let a rule author pin
/// gigabytes of compiled programs in the process-wide cache via nested
/// repetitions; an over-limit pattern fails to compile and routes through the
/// existing `Invalid` fail-closed path.
const REGEX_SIZE_LIMIT: usize = 1 << 20;

fn compile_regex(pattern: &str) -> Option<regex::bytes::Regex> {
    regex::bytes::RegexBuilder::new(pattern)
        .size_limit(REGEX_SIZE_LIMIT)
        .build()
        .ok()
}

/// Compile (or fetch) a `regex::bytes` pattern through a bounded process-wide
/// cache; `None` caches a compile failure so a broken pattern doesn't
/// recompile per request. On cache overflow, compile uncached (correctness
/// identical, just slower).
fn compiled_regex(pattern: &str) -> Option<regex::bytes::Regex> {
    static CACHE: OnceLock<Mutex<HashMap<String, Option<regex::bytes::Regex>>>> = OnceLock::new();
    const CACHE_CAP: usize = 256;
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Ok(mut map) = cache.lock() {
        if let Some(cached) = map.get(pattern) {
            return cached.clone();
        }
        let compiled = compile_regex(pattern);
        if map.len() < CACHE_CAP {
            map.insert(pattern.to_string(), compiled.clone());
        }
        return compiled;
    }
    compile_regex(pattern)
}

/// Apply a value operator (`contains`/`equals`/`regex`) over raw bytes.
/// `case_insensitive_contains` selects ASCII case folding for `contains` —
/// `body` targets only (the module doc's divergence note); `header`
/// `contains`, and `equals`/`regex` on ANY target, stay byte-exact
/// (`regex`'s own `(?i)` is the case-insensitive escape hatch there).
fn eval_operator(
    operator: &str,
    haystack: &[u8],
    value: &str,
    case_insensitive_contains: bool,
) -> CondEval {
    match operator {
        "contains" => {
            let hit = if case_insensitive_contains {
                contains_bytes_ascii_ci(haystack, value.as_bytes())
            } else {
                contains_bytes(haystack, value.as_bytes())
            };
            if hit {
                CondEval::Match
            } else {
                CondEval::NoMatch
            }
        }
        "equals" => {
            if haystack == value.as_bytes() {
                CondEval::Match
            } else {
                CondEval::NoMatch
            }
        }
        "regex" => match compiled_regex(value) {
            Some(re) if re.is_match(haystack) => CondEval::Match,
            Some(_) => CondEval::NoMatch,
            None => CondEval::Invalid,
        },
        _ => CondEval::Invalid,
    }
}

fn eval_body_condition(cond: &RuleCondition, body: ConditionBody<'_>) -> CondEval {
    // `exists` is header-only ("has a body" is not a meaningful policy).
    if cond.operator == "exists" {
        return CondEval::Invalid;
    }
    let Some(value) = cond.value.as_deref() else {
        return CondEval::Invalid;
    };
    match body {
        // Absent body is a FACT, not a failure: `needs_body_buffer` is a
        // superset of "a body condition could be consulted", so `None` here
        // genuinely means the request had no body (GETs, WS upgrades) → match
        // against empty.
        ConditionBody::None => eval_operator(&cond.operator, &[], value, true),
        ConditionBody::Full(bytes) => eval_operator(&cond.operator, bytes, value, true),
        // Truncated: `equals` can never be soundly decided from a prefix
        // shorter than the real body (vetting decision 3) — always Invalid.
        // `contains`/`regex` resolve on the observed prefix: a hit is a
        // definite Match; a miss is UNKNOWN (the value may sit past the cap),
        // routed through the failure law by returning Invalid.
        ConditionBody::Truncated(bytes) => {
            if cond.operator == "equals" {
                return CondEval::Invalid;
            }
            match eval_operator(&cond.operator, bytes, value, true) {
                CondEval::Match => CondEval::Match,
                CondEval::NoMatch => CondEval::Invalid,
                CondEval::Invalid => CondEval::Invalid,
            }
        }
    }
}

fn eval_header_condition(cond: &RuleCondition, headers: Option<&hyper::HeaderMap>) -> CondEval {
    let Some(key) = cond.key.as_deref().filter(|k| !k.trim().is_empty()) else {
        return CondEval::Invalid;
    };
    // Header-name lookup is case-insensitive via HeaderMap; a name that isn't
    // a valid header name can never have been sent → unevaluable.
    let Ok(name) = HeaderName::from_bytes(key.as_bytes()) else {
        return CondEval::Invalid;
    };
    let values: Vec<&HeaderValue> = match headers {
        Some(headers) => headers.get_all(&name).iter().collect(),
        None => Vec::new(),
    };
    if cond.operator == "exists" {
        return if values.is_empty() {
            CondEval::NoMatch
        } else {
            CondEval::Match
        };
    }
    let Some(value) = cond.value.as_deref() else {
        return CondEval::Invalid;
    };
    // Any value of a multi-value header satisfies the condition; values are
    // compared case-sensitively on raw bytes (`(?i)` regex for insensitive).
    let mut result = CondEval::NoMatch;
    for v in values {
        match eval_operator(&cond.operator, v.as_bytes(), value, false) {
            CondEval::Match => return CondEval::Match,
            CondEval::Invalid => return CondEval::Invalid,
            CondEval::NoMatch => result = CondEval::NoMatch,
        }
    }
    result
}

fn eval_condition(
    cond: &RuleCondition,
    body: ConditionBody<'_>,
    headers: Option<&hyper::HeaderMap>,
) -> CondEval {
    match cond.target.as_str() {
        "body" => eval_body_condition(cond, body),
        "header" => eval_header_condition(cond, headers),
        _ => CondEval::Invalid,
    }
}

/// Warn ONCE per rule name that a condition is unevaluable (a stored broken
/// rule would otherwise log per request — per pseudo-rule variant on tool
/// fan-outs — and flood a busy host); repeats land at `debug!`. The seen-set
/// is bounded: past the cap, new names also log at debug (never unbounded
/// memory for log bookkeeping).
fn log_unevaluable(rule_name: &str, is_block: bool) {
    use std::collections::HashSet;
    static SEEN: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    const SEEN_CAP: usize = 1024;
    let first = SEEN
        .get_or_init(|| Mutex::new(HashSet::new()))
        .lock()
        .map(|mut seen| {
            !seen.contains(rule_name) && seen.len() < SEEN_CAP && seen.insert(rule_name.to_string())
        })
        .unwrap_or(true);
    let outcome = if is_block {
        "failing closed (rule matches)"
    } else {
        "rule falls through"
    };
    if first {
        warn!(rule = %rule_name, is_block, "policy: unevaluable rule condition — {outcome}");
    } else {
        debug!(rule = %rule_name, is_block, "policy: unevaluable rule condition — {outcome}");
    }
}

/// Does the rule's condition set hold for this request? Vacuously true without
/// behavioral conditions; else ALL conditions must match (AND). Any
/// unevaluable condition applies the failure law: the rule matches iff it is
/// a Block rule (see the module doc). `headers` is `None` when the caller has
/// no header view for this request (e.g. a throwaway matcher built before
/// headers are available); a header condition is then always `Invalid`.
pub fn matches(
    rule: &PolicyRule,
    body: ConditionBody<'_>,
    headers: Option<&hyper::HeaderMap>,
) -> bool {
    let conds = match decode_conditions(&rule.conditions_raw) {
        DecodedConditions::Vacuous => return true,
        DecodedConditions::Behavioral(conds) => conds,
    };
    let mut all_match = true;
    for cond in &conds {
        let eval = match cond {
            Ok(cond) => eval_condition(cond, body, headers),
            Err(()) => CondEval::Invalid,
        };
        match eval {
            CondEval::Match => {}
            CondEval::NoMatch => all_match = false,
            CondEval::Invalid => {
                let is_block = matches!(rule.action, PolicyAction::Block);
                log_unevaluable(&rule.name, is_block);
                return is_block;
            }
        }
    }
    all_match
}

// ── Body buffering ──────────────────────────────────────────────────────

pub async fn prepare_body(
    body: hyper::body::Incoming,
    method: &str,
    url: &str,
) -> anyhow::Result<(BufferedBody, reqwest::Body)> {
    let stream = Box::pin(BodyDataStream::new(body));
    let limit = condition_body_buffer_limit();
    let (buffered, observed_len, reassembled) = buffer_prefix(stream, limit).await?;

    if buffered.truncated {
        warn!(
            method = %method,
            url = %url,
            buffered = observed_len,
            limit,
            "request body exceeds condition buffer limit — restrictive body conditions treated as matched (fail closed)"
        );
    }

    Ok((buffered, reassembled))
}

/// Buffer up to `limit` bytes of `stream` and reassemble a pass-through body
/// that forwards the ORIGINAL bytes untouched. Also returns the total bytes
/// observed (≥ the buffered prefix; a lower bound on the body size, for the
/// truncation warn). `truncated` is exact: it is set only when the body
/// really has bytes past `limit` (a body of exactly `limit` bytes reads to
/// EOF and is `Full`), so the fail-closed arm never fires on a complete body.
async fn buffer_prefix<S, E>(
    mut stream: std::pin::Pin<Box<S>>,
    limit: usize,
) -> anyhow::Result<(BufferedBody, usize, reqwest::Body)>
where
    S: Stream<Item = Result<hyper::body::Bytes, E>> + Send + 'static,
    E: std::fmt::Display + Send + Sync + 'static,
{
    let mut chunks: Vec<hyper::body::Bytes> = Vec::with_capacity(4);
    let mut total_len: usize = 0;

    // Read until the body ends or PROVABLY exceeds the limit (strictly
    // greater), so an exactly-limit-sized body is recognized as complete.
    while total_len <= limit {
        match stream.next().await {
            Some(Ok(data)) => {
                total_len += data.len();
                chunks.push(data);
            }
            Some(Err(e)) => {
                return Err(anyhow::anyhow!(
                    "reading request body for condition check: {e}"
                ));
            }
            None => break,
        }
    }
    let truncated = total_len > limit;

    let mut buf = Vec::with_capacity(total_len.min(limit));
    for chunk in &chunks {
        let remaining = limit - buf.len();
        let take = remaining.min(chunk.len());
        buf.extend_from_slice(&chunk[..take]);
        if buf.len() >= limit {
            break;
        }
    }

    let peeked_stream = futures_util::stream::iter(chunks.into_iter().map(Ok::<_, std::io::Error>));
    let remaining_stream = stream.map(|r| r.map_err(|e| std::io::Error::other(e.to_string())));
    let reassembled = reqwest::Body::wrap_stream(peeked_stream.chain(remaining_stream));

    Ok((
        BufferedBody {
            bytes: buf,
            truncated,
        },
        total_len,
        reassembled,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_rule(conditions_json: Option<serde_json::Value>) -> PolicyRule {
        rule_with_action(conditions_json, crate::PolicyAction::Block)
    }

    fn rule_with_action(
        conditions_json: Option<serde_json::Value>,
        action: crate::PolicyAction,
    ) -> PolicyRule {
        PolicyRule {
            name: "test".to_string(),
            path_pattern: "*".to_string(),
            method: None,
            action,
            conditions_raw: conditions_json,
        }
    }

    fn body_contains(value: &str) -> serde_json::Value {
        serde_json::json!([{"target": "body", "operator": "contains", "value": value}])
    }

    fn body_equals(value: &str) -> serde_json::Value {
        serde_json::json!([{"target": "body", "operator": "equals", "value": value}])
    }

    fn headers(pairs: &[(&str, &str)]) -> hyper::HeaderMap {
        let mut map = hyper::HeaderMap::new();
        for (name, value) in pairs {
            map.append(
                HeaderName::from_bytes(name.as_bytes()).expect("header name"),
                HeaderValue::from_str(value).expect("header value"),
            );
        }
        map
    }

    // ── Decode + vacuous shapes ─────────────────────────────────────────

    #[test]
    fn no_conditions_is_vacuous() {
        let mut none = make_rule(Some(serde_json::json!([])));
        none.conditions_raw = None;
        let empty = make_rule(Some(serde_json::json!([])));
        // A session-policy OBJECT is granular scoping, not behavioral — must
        // stay vacuous or every granular allow rule would stop matching.
        let session = make_rule(Some(serde_json::json!({"repositories":["owner/repo"]})));
        for r in [&none, &empty, &session] {
            assert!(matches(r, ConditionBody::None, None));
        }
    }

    // ── Body operators (the required-green regression test) ─────────────

    /// The one test the WP-C plan requires to survive the port, still
    /// asserting body `contains` is case-insensitive — now via ASCII byte
    /// folding rather than a lossy UTF-8 lowercase (vetting decision 2).
    #[test]
    fn body_contains_match_case_insensitive() {
        let rule = make_rule(Some(body_contains("DELETE")));
        assert!(matches(
            &rule,
            ConditionBody::Full(b"please delete this item"),
            None
        ));
        assert!(matches(
            &rule,
            ConditionBody::Full(b"DELETE everything"),
            None
        ));
    }

    #[test]
    fn body_contains_no_match() {
        let rule = make_rule(Some(body_contains("secret")));
        assert!(!matches(&rule, ConditionBody::Full(b"nothing here"), None));
    }

    #[test]
    fn body_contains_binary_safe_no_lossy_utf8() {
        // Raw-byte matching: a needle inside a binary body still matches, and
        // invalid UTF-8 bytes never panic or get lossily replaced away.
        let rule = make_rule(Some(body_contains("secret")));
        let mut body = vec![0xFF, 0xFE, 0x00];
        body.extend_from_slice(b"SeCrEt");
        body.push(0x80);
        assert!(matches(&rule, ConditionBody::Full(&body), None));
    }

    #[test]
    fn body_equals_is_byte_exact() {
        let rule = make_rule(Some(body_equals("exact")));
        assert!(matches(&rule, ConditionBody::Full(b"exact"), None));
        assert!(!matches(&rule, ConditionBody::Full(b"EXACT"), None));
        assert!(!matches(&rule, ConditionBody::Full(b"exact-not"), None));
    }

    #[test]
    fn body_regex_matches_and_respects_case_flag() {
        let re = rule_with_action(
            Some(serde_json::json!([{
                "target": "body", "operator": "regex", "value": r"(?i)delete\s+repo"
            }])),
            crate::PolicyAction::Allow,
        );
        assert!(matches(
            &re,
            ConditionBody::Full(b"please DELETE repo now"),
            None
        ));
        assert!(!matches(&re, ConditionBody::Full(b"read repo"), None));

        let case_sensitive = rule_with_action(
            Some(serde_json::json!([{
                "target": "body", "operator": "regex", "value": "DELETE"
            }])),
            crate::PolicyAction::Allow,
        );
        assert!(!matches(
            &case_sensitive,
            ConditionBody::Full(b"delete repo"),
            None
        ));
    }

    #[test]
    fn empty_body_does_not_match_contains() {
        let rule = make_rule(Some(body_contains("test")));
        assert!(!matches(&rule, ConditionBody::Full(b""), None));
        assert!(!matches(&rule, ConditionBody::None, None));
    }

    #[test]
    fn conditions_are_anded() {
        let rule = make_rule(Some(serde_json::json!([
            {"target": "body", "operator": "contains", "value": "foo"},
            {"target": "body", "operator": "contains", "value": "bar"}
        ])));
        assert!(matches(&rule, ConditionBody::Full(b"foo and bar"), None));
        assert!(!matches(&rule, ConditionBody::Full(b"only foo here"), None));
        assert!(!matches(&rule, ConditionBody::Full(b"only bar here"), None));
    }

    #[test]
    fn exists_on_body_is_invalid() {
        let rule = make_rule(Some(serde_json::json!([
            {"target": "body", "operator": "exists"}
        ])));
        // Block: fail closed (matches). Allow: falls through.
        assert!(matches(&rule, ConditionBody::Full(b"anything"), None));
        let allow = rule_with_action(
            Some(serde_json::json!([{"target": "body", "operator": "exists"}])),
            crate::PolicyAction::Allow,
        );
        assert!(!matches(&allow, ConditionBody::Full(b"anything"), None));
    }

    // ── Header conditions ───────────────────────────────────────────────

    #[test]
    fn header_name_lookup_is_case_insensitive() {
        let rule = make_rule(Some(serde_json::json!([
            {"target": "header", "operator": "equals", "key": "X-Foo", "value": "bar"}
        ])));
        let map = headers(&[("x-foo", "bar")]);
        assert!(matches(&rule, ConditionBody::None, Some(&map)));
    }

    #[test]
    fn header_values_are_case_sensitive_unless_regex_opts_in() {
        let map = headers(&[("x-multi", "first"), ("x-multi", "second-value")]);

        let eq = make_rule(Some(serde_json::json!([
            {"target": "header", "operator": "equals", "key": "x-multi", "value": "second-value"}
        ])));
        assert!(
            matches(&eq, ConditionBody::None, Some(&map)),
            "any value satisfies"
        );

        let eq_wrong_case = make_rule(Some(serde_json::json!([
            {"target": "header", "operator": "equals", "key": "x-multi", "value": "SECOND-VALUE"}
        ])));
        assert!(!matches(&eq_wrong_case, ConditionBody::None, Some(&map)));

        let contains = make_rule(Some(serde_json::json!([
            {"target": "header", "operator": "contains", "key": "x-multi", "value": "econd"}
        ])));
        assert!(matches(&contains, ConditionBody::None, Some(&map)));
        let contains_wrong_case = make_rule(Some(serde_json::json!([
            {"target": "header", "operator": "contains", "key": "x-multi", "value": "ECOND"}
        ])));
        assert!(!matches(
            &contains_wrong_case,
            ConditionBody::None,
            Some(&map)
        ));

        let re = make_rule(Some(serde_json::json!([
            {"target": "header", "operator": "regex", "key": "x-multi", "value": "^SECOND"}
        ])));
        assert!(!matches(&re, ConditionBody::None, Some(&map)));
        let re_i = make_rule(Some(serde_json::json!([
            {"target": "header", "operator": "regex", "key": "x-multi", "value": "(?i)^SECOND"}
        ])));
        assert!(matches(&re_i, ConditionBody::None, Some(&map)));
    }

    #[test]
    fn header_exists_and_missing_header() {
        let map = headers(&[("x-present", "v")]);
        let exists = make_rule(Some(serde_json::json!([
            {"target": "header", "operator": "exists", "key": "x-present"}
        ])));
        assert!(matches(&exists, ConditionBody::None, Some(&map)));

        // Missing header → NoMatch for every operator, exists included (an
        // ALLOW falls through AND a BLOCK falls through — absence is a fact).
        let missing_eq = make_rule(Some(serde_json::json!([
            {"target": "header", "operator": "equals", "key": "x-gone", "value": "v"}
        ])));
        assert!(!matches(&missing_eq, ConditionBody::None, Some(&map)));
        let missing_exists = make_rule(Some(serde_json::json!([
            {"target": "header", "operator": "exists", "key": "x-gone"}
        ])));
        assert!(!matches(&missing_exists, ConditionBody::None, Some(&map)));
        // No headers at all behaves like the header being absent.
        assert!(!matches(&missing_exists, ConditionBody::None, None));
    }

    #[test]
    fn header_without_key_is_invalid() {
        let rule = make_rule(Some(serde_json::json!([
            {"target": "header", "operator": "equals", "value": "x"}
        ])));
        assert!(matches(&rule, ConditionBody::None, None));
        let allow = rule_with_action(
            Some(serde_json::json!([
                {"target": "header", "operator": "equals", "value": "x"}
            ])),
            crate::PolicyAction::Allow,
        );
        assert!(!matches(&allow, ConditionBody::None, None));
    }

    #[test]
    fn header_invalid_name_is_invalid() {
        let rule = make_rule(Some(serde_json::json!([
            {"target": "header", "operator": "equals", "key": "bad name", "value": "x"}
        ])));
        assert!(matches(&rule, ConditionBody::None, None));
    }

    #[test]
    fn header_exists_is_header_only_in_reverse_too() {
        // `exists` on `body` was already covered above; confirm `header`
        // `exists` needs no `value`.
        let map = headers(&[("x-flag", "")]);
        let rule = make_rule(Some(serde_json::json!([
            {"target": "header", "operator": "exists", "key": "x-flag"}
        ])));
        assert!(matches(&rule, ConditionBody::None, Some(&map)));
    }

    // ── deny_unknown_fields / malformed shapes ───────────────────────────

    #[test]
    fn malformed_condition_json_fails_closed_by_action() {
        for cond in [
            r#"[42]"#,                                                     // garbage element
            r#"[{"target":"body","operator":"telepathy","value":"x"}]"#,   // unknown operator
            r#"[{"target":"cookies","operator":"contains","value":"x"}]"#, // unknown target
            r#"[{"target":"body","operator":"contains"}]"#,                // missing value
            r#"[{"target":"header","operator":"equals","value":"x"}]"#,    // header w/o key
            r#"[{"target":"header","operator":"equals","key":"bad name","value":"x"}]"#,
            r#"[{"target":"body","operator":"exists"}]"#, // exists on body
            // Unknown field: a future narrowing/inverting flag (e.g. `negate`)
            // must fail decode, not silently drop and widen matching.
            r#"[{"target":"body","operator":"contains","value":"x","negate":true}]"#,
            r#""nonsense""#, // non-array/object
        ] {
            let conditions: serde_json::Value = serde_json::from_str(cond).expect("test JSON");
            let block = make_rule(Some(conditions.clone()));
            let allow = rule_with_action(Some(conditions), crate::PolicyAction::Allow);
            assert!(
                matches(&block, ConditionBody::Full(b"body"), None),
                "{cond}"
            );
            assert!(
                !matches(&allow, ConditionBody::Full(b"body"), None),
                "{cond}"
            );
        }
    }

    #[test]
    fn uncompilable_regex_fails_closed_for_block() {
        // The headline security case: a Block whose regex Rust rejects (JS
        // lookbehind) must BLOCK, never silently fall through.
        let cond = serde_json::json!([
            {"target": "body", "operator": "regex", "value": "(?<=x)y["}
        ]);
        let block = make_rule(Some(cond.clone()));
        let allow = rule_with_action(Some(cond), crate::PolicyAction::Allow);
        assert!(matches(&block, ConditionBody::Full(b"anything"), None));
        assert!(!matches(&allow, ConditionBody::Full(b"anything"), None));
    }

    #[test]
    fn oversized_regex_program_fails_closed() {
        // Nested repetitions can approach the compiler's size limit; capping
        // it at `REGEX_SIZE_LIMIT` (instead of the 10 MiB default) keeps a
        // rule author from pinning gigabytes of compiled programs in the
        // process-wide cache. Over-limit patterns fail to compile → the
        // Invalid fail-closed path.
        assert!(compile_regex("(?:x{1000}){1000}").is_none(), "over the cap");
        assert!(compile_regex("(?i)delete\\s+repo").is_some(), "normal");
        let cond = serde_json::json!([
            {"target": "body", "operator": "regex", "value": "(?:x{1000}){1000}"}
        ]);
        let block = make_rule(Some(cond.clone()));
        let allow = rule_with_action(Some(cond), crate::PolicyAction::Allow);
        assert!(matches(&block, ConditionBody::Full(b"x"), None));
        assert!(!matches(&allow, ConditionBody::Full(b"x"), None));
    }

    #[test]
    fn regex_cache_caches_compile_failures() {
        // Calling twice must not panic / recompile-crash; a cached failure
        // stays a failure (Invalid) both times.
        let pattern = "(?<=cached)fail[";
        assert!(compiled_regex(pattern).is_none());
        assert!(compiled_regex(pattern).is_none());
    }

    // ── Truncation fail-closed law (vetting decision 3) ──────────────────

    #[test]
    fn truncated_prefix_hit_matches_for_both_polarities() {
        let block = make_rule(Some(body_contains("delete")));
        let allow = rule_with_action(Some(body_contains("delete")), crate::PolicyAction::Allow);
        assert!(matches(
            &block,
            ConditionBody::Truncated(b"please delete it"),
            None
        ));
        assert!(matches(
            &allow,
            ConditionBody::Truncated(b"please delete it"),
            None
        ));
    }

    #[test]
    fn truncated_miss_matches_restrictive_rules_only() {
        // The regression #999: the value may sit past the cap, so a Block
        // rule must treat the unknown as matched (fail closed); an Allow must
        // not be granted on unseen bytes.
        let conditions = body_contains("wire-transfer");
        let prefix = ConditionBody::Truncated(b"an innocuous prefix");
        let block = make_rule(Some(conditions.clone()));
        let allow = rule_with_action(Some(conditions), crate::PolicyAction::Allow);
        assert!(
            matches(&block, prefix, None),
            "restrictive rule must match on a truncated miss"
        );
        assert!(!matches(&allow, prefix, None));
    }

    #[test]
    fn truncated_regex_miss_resolves_by_polarity_too() {
        let conditions = serde_json::json!([
            {"target": "body", "operator": "regex", "value": "wire-transfer"}
        ]);
        let prefix = ConditionBody::Truncated(b"an innocuous prefix");
        let block = make_rule(Some(conditions.clone()));
        let allow = rule_with_action(Some(conditions), crate::PolicyAction::Allow);
        assert!(matches(&block, prefix, None));
        assert!(!matches(&allow, prefix, None));
    }

    #[test]
    fn truncated_equals_is_always_invalid_even_on_a_content_match() {
        // vetting decision 3: `equals` can never be soundly decided from a
        // prefix — even when the observed prefix happens to equal the value
        // byte-for-byte, the real (longer) body cannot equal it.
        let conditions = body_equals("exact");
        let prefix = ConditionBody::Truncated(b"exact");
        let block = make_rule(Some(conditions.clone()));
        let allow = rule_with_action(Some(conditions), crate::PolicyAction::Allow);
        assert!(matches(&block, prefix, None), "Block fails closed");
        assert!(!matches(&allow, prefix, None), "Allow falls through");
    }

    #[test]
    fn truncated_multi_condition_uses_polarity_per_condition() {
        let conditions = Some(serde_json::json!([
            {"target": "body", "operator": "contains", "value": "seen"},
            {"target": "body", "operator": "contains", "value": "unseen"}
        ]));
        let prefix = ConditionBody::Truncated(b"the seen value only");
        assert!(matches(
            &rule_with_action(conditions.clone(), crate::PolicyAction::Block),
            prefix,
            None
        ));
        assert!(!matches(
            &rule_with_action(conditions, crate::PolicyAction::Allow),
            prefix,
            None
        ));
    }

    #[test]
    fn condition_body_from_buffered() {
        let full = BufferedBody {
            bytes: b"abc".to_vec(),
            truncated: false,
        };
        let cut = BufferedBody {
            bytes: b"abc".to_vec(),
            truncated: true,
        };
        assert_eq!(
            ConditionBody::from_buffered(Some(&full)),
            ConditionBody::Full(b"abc")
        );
        assert_eq!(
            ConditionBody::from_buffered(Some(&cut)),
            ConditionBody::Truncated(b"abc")
        );
        assert_eq!(ConditionBody::from_buffered(None), ConditionBody::None);
    }

    // ── buffer_prefix: exact truncation detection + byte-perfect relay ──

    fn chunk_stream(
        chunks: Vec<&'static [u8]>,
    ) -> std::pin::Pin<Box<impl Stream<Item = Result<hyper::body::Bytes, std::io::Error>>>> {
        Box::pin(futures_util::stream::iter(
            chunks
                .into_iter()
                .map(|c| Ok(hyper::body::Bytes::from_static(c))),
        ))
    }

    async fn collect_body(body: reqwest::Body) -> Vec<u8> {
        use http_body_util::BodyExt;
        body.collect().await.expect("body").to_bytes().to_vec()
    }

    #[tokio::test]
    async fn buffer_prefix_complete_body_is_not_truncated() {
        let (buffered, observed, relay) =
            buffer_prefix(chunk_stream(vec![b"hello ", b"world"]), 64)
                .await
                .expect("buffer");
        assert!(!buffered.truncated);
        assert_eq!(observed, 11);
        assert_eq!(buffered.bytes, b"hello world");
        assert_eq!(collect_body(relay).await, b"hello world");
    }

    #[tokio::test]
    async fn buffer_prefix_exactly_limit_sized_body_is_full() {
        // A body of exactly `limit` bytes must read to EOF and count as
        // complete — the old `>=` check would have flagged it truncated.
        let (buffered, _, relay) = buffer_prefix(chunk_stream(vec![b"12345678"]), 8)
            .await
            .expect("buffer");
        assert!(!buffered.truncated);
        assert_eq!(buffered.bytes, b"12345678");
        assert_eq!(collect_body(relay).await, b"12345678");
    }

    #[tokio::test]
    async fn buffer_prefix_oversized_body_truncates_and_relays_all_bytes() {
        let (buffered, observed, relay) =
            buffer_prefix(chunk_stream(vec![b"12345678", b"9abcdef"]), 8)
                .await
                .expect("buffer");
        assert!(buffered.truncated);
        assert_eq!(observed, 15);
        assert_eq!(buffered.bytes, b"12345678");
        // Buffering must never corrupt the forwarded body.
        assert_eq!(collect_body(relay).await, b"123456789abcdef");
    }

    #[tokio::test]
    async fn buffer_prefix_empty_body() {
        let (buffered, _, relay) = buffer_prefix(chunk_stream(vec![]), 8)
            .await
            .expect("buffer");
        assert!(!buffered.truncated);
        assert!(buffered.bytes.is_empty());
        assert!(collect_body(relay).await.is_empty());
    }

    // ── buffer-limit resolution: default, override, clamp ────────────────

    #[test]
    fn buffer_limit_defaults_and_rejects_garbage() {
        assert_eq!(resolve_buffer_limit(None), DEFAULT_CONDITION_BODY_BUFFER);
        assert_eq!(
            resolve_buffer_limit(Some("not a number".to_string())),
            DEFAULT_CONDITION_BODY_BUFFER
        );
        assert_eq!(
            resolve_buffer_limit(Some("-1".to_string())),
            DEFAULT_CONDITION_BODY_BUFFER
        );
    }

    #[test]
    fn buffer_limit_honors_in_window_overrides_and_clamps_extremes() {
        assert_eq!(resolve_buffer_limit(Some(" 65536 ".to_string())), 65_536);
        // 0 would truncate EVERY body → mass fail-closed blocking; the floor
        // keeps a bad value from weaponizing the fail-closed law.
        assert_eq!(
            resolve_buffer_limit(Some("0".to_string())),
            MIN_CONDITION_BODY_BUFFER
        );
        // The ceiling bounds worst-case per-request memory.
        assert_eq!(
            resolve_buffer_limit(Some(usize::MAX.to_string())),
            MAX_CONDITION_BODY_BUFFER
        );
    }
}
