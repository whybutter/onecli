//! Per-connection resource scoping (GitHub repository lists, Dropbox folder
//! allowlists) and the pure scope-composition primitives that back it.
//!
//! Phase 0 posture: `denies_everything` and `intersect_policies` are pure
//! functions with a complete decision table
//! (`docs/upstream-sync/v2-migration/phase0-plan.md` Orchestrator vetting
//! note 2; `gateway-ee-behaviour.md` §1.3-§1.5) — a partial, exact-match-only
//! version would leave a window where a nested-folder or cross-org boundary
//! is mis-composed (mis-composing it wider than intended is a
//! credential-scope leak), so they ship in full.
//!
//! The per-request/per-mint enforcement seams (`needs_request_body`,
//! `enforce_request`, `has_request_guard` for Dropbox;  `has_token_scoper`,
//! `scope_token` for GitHub App) also ship in full here rather than as
//! DROP stand-ins: the free `proxy::connect`/`proxy::hooks` call sites for
//! these are NOT gated by `entitled` — they run in every edition today (only
//! the boundary/selection *composition* in `stamp_resource_scopes` is
//! entitlement-gated). Two in-crate free tests
//! (`proxy::connect::deferred_injection_tests::a_resource_scoped_connection_defers_its_credential`,
//! `…a_request_guarded_provider_keeps_its_credential_under_a_scope`) already
//! exercise this unconditionally and are part of the `cargo test --workspace`
//! gate — stubbing these to false/None fails both, and worse, a `false`
//! `has_request_guard("dropbox")` combined with a real credential mint would
//! silently serve the stored Dropbox token WITHOUT ever calling
//! `enforce_request` to check it, which is a real scope leak, not a
//! conservative default. `gateway-ee-behaviour.md` §1.13 ("Fork relevance")
//! independently confirms these are meant to KEEP entirely. See
//! `granular_access::{github, dropbox}` for the implementations.

use std::collections::BTreeSet;

use serde_json::Value;

mod dropbox;
mod github;

/// Why a request/credential was denied. Read by `proxy::hooks` to build the
/// agent-facing `resource_access_denied` response.
#[derive(Debug)]
pub struct Denial {
    pub reason: String,
    pub allowed: Vec<String>,
    pub rule_name: &'static str,
}

/// Whether the request-level guard needs the buffered request body to reach
/// a decision. Only Dropbox registers a request guard.
#[must_use]
pub fn needs_request_body(policy: Option<&Value>, host: &str, _method: &str, _path: &str) -> bool {
    let host = common::util::strip_port(host).to_lowercase();
    match apps::provider_for_host(&host) {
        Some((provider, _)) if provider == dropbox::PROVIDER => dropbox::needs_body(policy, &host),
        _ => false,
    }
}

/// Request-level enforcement. Only Dropbox registers a request guard; every
/// other provider passes through (either it has no scope concept, or it is
/// enforced at token-mint time instead — see `has_token_scoper`/`scope_token`).
#[must_use]
pub fn enforce_request(
    policy: Option<&Value>,
    host: &str,
    path: &str,
    headers: &hyper::HeaderMap,
    body: Option<&[u8]>,
) -> Option<Denial> {
    let host = common::util::strip_port(host).to_lowercase();
    match apps::provider_for_host(&host) {
        Some((provider, _)) if provider == dropbox::PROVIDER => {
            dropbox::enforce(policy, &host, path, headers, body)
        }
        _ => None,
    }
}

/// The two resource-policy axes this build recognises, in priority order
/// (also the tie-break order `denies_everything`/`intersect_policies` use
/// when a policy object happens to carry more than one).
const AXES: [&str; 2] = ["repositories", "folders"];

/// Whether `policy` is a recognised resource policy, and if so, its axis key
/// and the RAW (un-normalized) JSON value at that key.
///
/// "Not a resource policy" = JSON null, non-object, empty object, or an
/// object without a recognised key (`gateway-ee-behaviour.md` §1.4) — every
/// one of those makes `.as_object()` fail or `AXES.iter().find` come up
/// empty, so a single early-return covers all four.
fn axis_of(policy: &Value) -> Option<(&'static str, &Value)> {
    let obj = policy.as_object()?;
    AXES.iter()
        .find_map(|axis| obj.get(*axis).map(|v| (*axis, v)))
}

/// The string entries of a JSON value, or an empty list if the value isn't an
/// array. Non-string array entries are dropped, not errored on — "raw entries
/// that are not strings are ignored" (`gateway-ee-behaviour.md` §1.4).
fn string_entries(value: &Value) -> Vec<String> {
    value
        .as_array()
        .map(|entries| {
            entries
                .iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

/// Normalize one axis entry: lowercase for both axes; `folders` additionally
/// strips one trailing slash (so the account root `"/"` normalizes to the
/// empty string, the sentinel for "boundary covers everything").
fn normalize_entry(axis: &str, entry: &str) -> String {
    let lower = entry.to_ascii_lowercase();
    if axis == "folders" {
        lower.strip_suffix('/').map(str::to_string).unwrap_or(lower)
    } else {
        lower
    }
}

/// Whether a normalized `entry` is within `boundary` (a normalized entry
/// list) for `axis`.
///
/// `repositories`: exact match only — names never nest (`org/a` is not
/// inside `org/a-extra`, `org` is not inside `org/a`).
/// `folders`: a boundary entry that normalized to the root (empty string)
/// covers everything; otherwise `entry` must equal a boundary entry or sit
/// under it at a segment boundary (`entry == b || entry.starts_with(b + "/")`)
/// — matching the Dropbox `path_allowed` rule so a name doesn't accidentally
/// match a same-prefixed sibling (`/marketing` does not admit
/// `/marketing-2024/x`). The empty entry itself (root as a *target*) is never
/// "covered" by a non-root boundary.
fn covered_by(axis: &str, entry: &str, boundary: &[String]) -> bool {
    match axis {
        "folders" => {
            if boundary.iter().any(|b| b.is_empty()) {
                return true;
            }
            !entry.is_empty()
                && boundary
                    .iter()
                    .any(|b| entry == b || entry.starts_with(&format!("{b}/")))
        }
        // "repositories", and any future axis this build doesn't specially
        // recognise: exact match after normalization.
        _ => boundary.iter().any(|b| b == entry),
    }
}

/// Symmetric intersection of two RAW entry lists on `axis`: normalize both,
/// then keep every entry of either side that the OTHER side's (normalized)
/// list covers. Sorted + deduped (a `BTreeSet` gives us both for free) —
/// load-bearing, since the composed policy is part of an injection cache key.
fn intersect_axis(axis: &str, a: &[String], b: &[String]) -> Vec<String> {
    let na: Vec<String> = a.iter().map(|e| normalize_entry(axis, e)).collect();
    let nb: Vec<String> = b.iter().map(|e| normalize_entry(axis, e)).collect();

    let mut result: BTreeSet<String> = BTreeSet::new();
    for e in &na {
        if covered_by(axis, e, &nb) {
            result.insert(e.clone());
        }
    }
    for e in &nb {
        if covered_by(axis, e, &na) {
            result.insert(e.clone());
        }
    }
    result.into_iter().collect()
}

/// True iff `policy` explicitly denies every request: an object whose
/// recognised axis key (`repositories` or `folders`) holds an EMPTY array.
///
/// Reads RAW entries, deliberately not normalized ones: `{"folders": ["/"]}`
/// must read as false (root is the widest scope, not deny-all) even though
/// normalization would otherwise reduce `"/"` to the same empty-string
/// sentinel this function is checking arrays *length* against — normalizing
/// first would conflate "one entry that happens to mean everything" with
/// "zero entries, meaning nothing" (`gateway-ee-behaviour.md` §1.5).
#[must_use]
pub fn denies_everything(policy: Option<&Value>) -> bool {
    let Some(policy) = policy else {
        return false;
    };
    let Some(obj) = policy.as_object() else {
        return false;
    };
    AXES.iter().any(|axis| {
        obj.get(*axis)
            .and_then(Value::as_array)
            .is_some_and(Vec::is_empty)
    })
}

/// Compose an ORG resource boundary with a WORKSPACE selection (or fold
/// multiple boundaries together) into the effective scope a credential may
/// reach. See `gateway-ee-behaviour.md` §1.4 for the full decision table;
/// summary:
///
/// - Both sides absent-or-not-a-resource-policy → `None`.
/// - Exactly one side is present (`None`, or present but not a recognised
///   resource policy) → the OTHER side, cloned verbatim, un-normalized.
/// - Both sides are resource policies on the SAME axis → the axis'
///   symmetric, normalized, sorted+deduped intersection (may be `{axis: []}`,
///   the deny-all sentinel).
/// - Both sides are resource policies on DIFFERENT axes → deny-all on the
///   FIRST argument's axis (`{axis_of(a): []}`), with a warning — an
///   axis mismatch means the two grants can never agree on what "in scope"
///   means, so the safe reading is "nothing is".
#[must_use]
pub fn intersect_policies(a: Option<&Value>, b: Option<&Value>) -> Option<Value> {
    match (a, b) {
        (None, None) => None,
        (Some(x), None) => Some(x.clone()),
        (None, Some(y)) => Some(y.clone()),
        (Some(x), Some(y)) => match (axis_of(x), axis_of(y)) {
            (None, None) => None,
            (Some(_), None) => Some(x.clone()),
            (None, Some(_)) => Some(y.clone()),
            (Some((axis_a, val_a)), Some((axis_b, val_b))) => {
                if axis_a == axis_b {
                    let entries =
                        intersect_axis(axis_a, &string_entries(val_a), &string_entries(val_b));
                    Some(serde_json::json!({ axis_a: entries }))
                } else {
                    tracing::warn!(
                        axis_a,
                        axis_b,
                        "intersecting resource policies on mismatched axes; denying all access on the first policy's axis"
                    );
                    Some(serde_json::json!({ axis_a: Vec::<String>::new() }))
                }
            }
        },
    }
}

/// Whether `provider` registers a request-level guard. Only Dropbox does —
/// `proxy::connect` reads this to decide whether a scoped-but-unminted
/// credential may still be served (because something else will enforce the
/// scope per request) or must be withheld outright.
#[must_use]
pub fn has_request_guard(provider: &str) -> bool {
    provider == dropbox::PROVIDER
}

/// Whether `cred_type` registers a token-level scoper. Only GitHub App does.
#[must_use]
pub fn has_token_scoper(cred_type: &str) -> bool {
    github::has_scoper(cred_type)
}

/// Attempt a scoped token mint for a credential type that registers a
/// scoper. `None` for every other credential type — the caller falls through
/// to the ordinary, unscoped credential refresh.
pub async fn scope_token(
    cred_type: &str,
    creds: &Value,
    policy: Option<&Value>,
) -> Option<anyhow::Result<(String, i64)>> {
    if github::has_scoper(cred_type) {
        github::scope(creds, policy).await
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // ── denies_everything — gateway-ee-behaviour.md §1.5 ────────────────

    #[test]
    fn denies_everything_none_is_false() {
        assert!(!denies_everything(None));
    }

    #[test]
    fn denies_everything_null_is_false() {
        assert!(!denies_everything(Some(&json!(null))));
    }

    #[test]
    fn denies_everything_empty_object_is_false() {
        assert!(!denies_everything(Some(&json!({}))));
    }

    #[test]
    fn denies_everything_behavioural_array_is_false() {
        assert!(!denies_everything(Some(&json!(["some_condition"]))));
    }

    #[test]
    fn denies_everything_unknown_key_is_false() {
        assert!(!denies_everything(Some(&json!({"unknown": []}))));
    }

    #[test]
    fn denies_everything_empty_repositories_is_true() {
        assert!(denies_everything(Some(&json!({"repositories": []}))));
    }

    #[test]
    fn denies_everything_empty_folders_is_true() {
        assert!(denies_everything(Some(&json!({"folders": []}))));
    }

    #[test]
    fn denies_everything_nonempty_repositories_is_false() {
        assert!(!denies_everything(Some(
            &json!({"repositories": ["org/a"]})
        )));
    }

    #[test]
    fn denies_everything_root_folder_is_false() {
        // Root is the widest scope, not deny-all — read from the RAW (non-empty)
        // array, not the normalized (empty-string) entry.
        assert!(!denies_everything(Some(&json!({"folders": ["/"]}))));
    }

    #[test]
    fn denies_everything_non_array_value_is_false() {
        assert!(!denies_everything(Some(
            &json!({"repositories": "not-an-array"})
        )));
    }

    // ── intersect_policies — gateway-ee-behaviour.md §1.4 ───────────────

    #[test]
    fn intersect_both_none_is_none() {
        assert_eq!(intersect_policies(None, None), None);
    }

    #[test]
    fn intersect_some_and_none_clones_the_some_side_unnormalized() {
        let policy = json!({"repositories": ["Org/A", "org/a"]});
        assert_eq!(
            intersect_policies(Some(&policy), None),
            Some(policy.clone())
        );
        assert_eq!(intersect_policies(None, Some(&policy)), Some(policy));
    }

    #[test]
    fn intersect_not_a_resource_policy_and_none_clones_verbatim() {
        let garbage = json!(["a_condition"]);
        assert_eq!(
            intersect_policies(Some(&garbage), None),
            Some(garbage.clone())
        );
        assert_eq!(intersect_policies(None, Some(&garbage)), Some(garbage));
    }

    #[test]
    fn intersect_one_resource_one_not_keeps_the_resource_side() {
        let resource = json!({"repositories": ["org/a"]});
        let garbage = json!({});
        assert_eq!(
            intersect_policies(Some(&resource), Some(&garbage)),
            Some(resource.clone())
        );
        assert_eq!(
            intersect_policies(Some(&garbage), Some(&resource)),
            Some(resource)
        );
    }

    #[test]
    fn intersect_both_not_a_resource_policy_is_none() {
        assert_eq!(
            intersect_policies(Some(&json!({})), Some(&json!(null))),
            None
        );
    }

    #[test]
    fn intersect_pinned_repositories_example() {
        let a = json!({"repositories": ["buckle/electron", "buckle/api"]});
        let b = json!({"repositories": ["buckle/api"]});
        assert_eq!(
            intersect_policies(Some(&a), Some(&b)),
            Some(json!({"repositories": ["buckle/api"]}))
        );
    }

    #[test]
    fn intersect_pinned_case_insensitive_dedup_example() {
        let a = json!({"repositories": ["org/b", "org/a", "ORG/A"]});
        let b = json!({"repositories": ["org/a", "org/b"]});
        assert_eq!(
            intersect_policies(Some(&a), Some(&b)),
            Some(json!({"repositories": ["org/a", "org/b"]}))
        );
    }

    #[test]
    fn intersect_folders_symmetric_containment_either_side() {
        let parent = json!({"folders": ["/clients"]});
        let child = json!({"folders": ["/clients/acme"]});
        assert_eq!(
            intersect_policies(Some(&parent), Some(&child)),
            Some(json!({"folders": ["/clients/acme"]}))
        );
        assert_eq!(
            intersect_policies(Some(&child), Some(&parent)),
            Some(json!({"folders": ["/clients/acme"]}))
        );
    }

    #[test]
    fn intersect_root_boundary_is_widest_scope() {
        let root = json!({"folders": ["/"]});
        let scoped = json!({"folders": ["/clients"]});
        assert_eq!(
            intersect_policies(Some(&root), Some(&scoped)),
            Some(json!({"folders": ["/clients"]}))
        );
    }

    #[test]
    fn intersect_sibling_folders_deny_all() {
        let a = json!({"folders": ["/marketing"]});
        let b = json!({"folders": ["/sales"]});
        assert_eq!(
            intersect_policies(Some(&a), Some(&b)),
            Some(json!({"folders": []}))
        );
    }

    #[test]
    fn intersect_prefix_sibling_is_not_contained() {
        // `/marketing` must not admit `/marketing-2024` — segment boundary,
        // not string-prefix.
        let a = json!({"folders": ["/marketing"]});
        let b = json!({"folders": ["/marketing-2024/x"]});
        assert_eq!(
            intersect_policies(Some(&a), Some(&b)),
            Some(json!({"folders": []}))
        );
    }

    #[test]
    fn intersect_mismatched_axes_denies_on_the_first_argument_axis() {
        let repos = json!({"repositories": ["org/a"]});
        let folders = json!({"folders": ["/clients"]});
        assert_eq!(
            intersect_policies(Some(&repos), Some(&folders)),
            Some(json!({"repositories": []}))
        );
        // Order matters: the deny-all sentinel lands on whichever axis came
        // first (the `a` argument), per the decision table.
        assert_eq!(
            intersect_policies(Some(&folders), Some(&repos)),
            Some(json!({"folders": []}))
        );
    }

    #[test]
    fn intersect_non_array_axis_value_yields_empty_entry_list() {
        let a = json!({"repositories": "not-an-array"});
        let b = json!({"repositories": ["org/a"]});
        assert_eq!(
            intersect_policies(Some(&a), Some(&b)),
            Some(json!({"repositories": []}))
        );
    }

    #[test]
    fn intersect_non_string_entries_are_ignored() {
        let a = json!({"repositories": ["org/a", 42, null]});
        let b = json!({"repositories": ["org/a"]});
        assert_eq!(
            intersect_policies(Some(&a), Some(&b)),
            Some(json!({"repositories": ["org/a"]}))
        );
    }

    // ── has_request_guard / has_token_scoper dispatch ───────────────────
    // Per-provider mechanics live in the `dropbox`/`github` submodules; these
    // just confirm the dispatch keys on the right identifier (provider name
    // for the request guard, credential-payload type for the token scoper).

    #[test]
    fn has_request_guard_is_dropbox_only() {
        assert!(has_request_guard("dropbox"));
        assert!(!has_request_guard("github-app"));
        assert!(!has_request_guard("gmail"));
    }

    #[test]
    fn has_token_scoper_is_github_app_only() {
        assert!(has_token_scoper("github_app"));
        assert!(!has_token_scoper("dropbox"));
    }

    #[test]
    fn needs_request_body_is_false_off_the_dropbox_api_host() {
        assert!(!needs_request_body(
            Some(&json!({"folders": ["/clients"]})),
            "gmail.googleapis.com",
            "GET",
            "/p"
        ));
    }
}
