//! Dropbox request-level folder guard: every Dropbox API call is inspected
//! against the policy's `folders` allowlist, since (unlike GitHub) Dropbox
//! access tokens can't be scoped to a folder at mint time.
//!
//! `docs/upstream-sync/v2-migration/gateway-ee-behaviour.md` §1.8.

use serde_json::Value;

pub(super) const PROVIDER: &str = "dropbox";
const RULE_NAME: &str = "Dropbox folder policy";
const CONTENT_HOST: &str = "content.dropboxapi.com";
const API_HOST: &str = "api.dropboxapi.com";

/// Endpoints allowed outright, no path/body inspection needed. Every
/// cursor-*minting* endpoint (`list_folder`, `list_folder/get_latest_cursor`)
/// is path-checked below, which is what makes `list_folder/continue` safe to
/// allow unconditionally here.
const PATHLESS_ALLOWLIST: &[&str] = &[
    "/2/users/get_current_account",
    "/2/users/get_space_usage",
    "/2/users/get_account",
    "/2/users/get_account_batch",
    "/2/check/user",
    "/2/files/list_folder/continue",
    "/2/files/upload_session/start",
    "/2/files/upload_session/append",
    "/2/files/upload_session/append_v2",
];

fn normalize(entry: &str) -> String {
    let lower = entry.to_ascii_lowercase();
    lower.strip_suffix('/').map(str::to_string).unwrap_or(lower)
}

/// The policy's normalized `folders` allowlist, with empty (account-root)
/// entries dropped. `None` means "no restriction applies" — either the
/// `folders` key is absent/not-an-array, or every entry normalizes to root
/// (`gateway-ee-behaviour.md` §1.8: `{folders: []}` and `{folders: ["/"]}`
/// both mean "no guard" — the former is caught earlier by
/// `denies_everything`, the latter is genuinely unrestricted).
///
/// NOTE (Phase 0, not changed here): a `folders` key present with a raw,
/// non-empty array but ZERO usable string entries (e.g. `{"folders": [42]}`)
/// or a non-array value (`{"folders": "x"}`) also falls through to `None`
/// ("no restriction") today, per `gateway-ee-behaviour.md` §1.8's literal
/// reading of `folders(policy)`. This is a spec gap, not an implementation
/// bug: Phase 1 is expected to amend the spec so a recognised key with a
/// non-empty raw array and no usable entries denies-all instead (consistent
/// with how `denies_everything` already treats an explicitly empty array).
fn allowed_folders(policy: Option<&Value>) -> Option<Vec<String>> {
    let obj = policy?.as_object()?;
    let entries = obj.get("folders")?.as_array()?;
    let normalized: Vec<String> = entries
        .iter()
        .filter_map(|v| v.as_str())
        .map(normalize)
        .filter(|e| !e.is_empty())
        .collect();
    (!normalized.is_empty()).then_some(normalized)
}

/// Whether `target` (a raw request path/argument) falls within `allowed` — a
/// normalized folder list. The target must itself look like an absolute
/// path (`id:…`, `rev:…`, `ns:…` references are refused); must not contain a
/// `.`/`..` path segment or a backslash (defence in depth — Dropbox's own
/// handling of dot segments and backslashes is undocumented, so this guard
/// does not rely on it); and containment is segment-bounded so `/marketing`
/// does not admit `/marketing-2024/x`.
fn path_allowed(target: &str, allowed: &[String]) -> bool {
    if !target.starts_with('/') || target.contains('\\') {
        return false;
    }
    if target
        .split('/')
        .any(|segment| segment == "." || segment == "..")
    {
        return false;
    }
    let norm = normalize(target);
    if norm.is_empty() {
        return false;
    }
    allowed
        .iter()
        .any(|entry| norm == *entry || norm.starts_with(&format!("{entry}/")))
}

fn endpoint_of(path: &str) -> &str {
    path.split('?').next().unwrap_or(path)
}

/// Dropbox accepts `?arg=` (content-endpoint target) and, on some auth
/// flows, `?authorization=` as query-parameter alternatives to the
/// equivalent header/body — an override channel this guard otherwise never
/// inspects. A request that ships a compliant, in-scope header/body AND one
/// of these query parameters could smuggle a second, out-of-scope target
/// past every check below, so any occurrence denies the request outright
/// rather than being silently ignored. Case-insensitive key match, checked
/// against the raw query string (before `endpoint_of` strips it).
fn has_smuggled_query_param(path: &str) -> bool {
    let Some((_, query)) = path.split_once('?') else {
        return false;
    };
    query.split('&').any(|pair| {
        let key = pair.split('=').next().unwrap_or(pair);
        key.eq_ignore_ascii_case("arg") || key.eq_ignore_ascii_case("authorization")
    })
}

fn deny(reason: String, allowed: &[String]) -> Option<super::Denial> {
    Some(super::Denial {
        reason,
        allowed: allowed.to_vec(),
        rule_name: RULE_NAME,
    })
}

/// Validate every dotted target path (`"path"`, `"commit.path"`,
/// `"options.path"`, …) against `json`; the first missing/non-string/
/// out-of-scope target denies.
fn check_targets(
    json: &Value,
    targets: &[&str],
    endpoint: &str,
    allowed: &[String],
) -> Option<super::Denial> {
    for target in targets {
        let mut current = json;
        let mut found = true;
        for segment in target.split('.') {
            match current.get(segment) {
                Some(next) => current = next,
                None => {
                    found = false;
                    break;
                }
            }
        }
        let Some(value) = found.then(|| current.as_str()).flatten() else {
            return deny(format!("missing or invalid path for {endpoint}"), allowed);
        };
        if !path_allowed(value, allowed) {
            return deny(format!("path outside allowed folders: {value}"), allowed);
        }
    }
    None
}

/// Whether the request-forwarding path must buffer the request body for
/// `enforce` to inspect. The content host (`content.dropboxapi.com`) carries
/// its target in a header instead, so it never needs buffering.
pub(super) fn needs_body(policy: Option<&Value>, host: &str) -> bool {
    host == API_HOST && allowed_folders(policy).is_some()
}

/// Enforce the folder allowlist against one request. `host` must already be
/// port-stripped and lowercased by the caller.
pub(super) fn enforce(
    policy: Option<&Value>,
    host: &str,
    path: &str,
    headers: &hyper::HeaderMap,
    body: Option<&[u8]>,
) -> Option<super::Denial> {
    let allowed = allowed_folders(policy)?;
    let endpoint = endpoint_of(path);

    // Checked on BOTH hosts, before anything else: a smuggled `?arg=` or
    // `?authorization=` query parameter could name a second, out-of-scope
    // target alongside an otherwise-compliant header or body.
    if has_smuggled_query_param(path) {
        return deny(
            format!("ambiguous Dropbox request target for {endpoint}: query parameter override"),
            &allowed,
        );
    }

    if PATHLESS_ALLOWLIST.contains(&endpoint) {
        return None;
    }

    if host == CONTENT_HOST {
        let targets: &[&str] = match endpoint {
            "/2/files/upload_session/finish" => &["commit.path"],
            "/2/files/upload"
            | "/2/files/download"
            | "/2/files/download_zip"
            | "/2/files/get_preview"
            | "/2/files/get_thumbnail"
            | "/2/files/get_thumbnail_v2" => &["path"],
            _ => return deny(format!("endpoint not permitted: {endpoint}"), &allowed),
        };
        // hyper forwards every occurrence of a repeated header; exactly one
        // `Dropbox-API-Arg` is required. Zero is "missing", more than one is
        // "ambiguous" (a second, attacker-controlled value the real Dropbox
        // API would itself reject, or interpret differently than this guard
        // — either way, never resolve the ambiguity in the requester's favor).
        let values = headers.get_all("Dropbox-API-Arg");
        if values.iter().count() != 1 {
            return deny("ambiguous Dropbox-API-Arg".to_string(), &allowed);
        }
        let Some(header_value) = values.iter().next().and_then(|v| v.to_str().ok()) else {
            return deny(format!("missing or invalid path for {endpoint}"), &allowed);
        };
        let Ok(json) = serde_json::from_str::<Value>(header_value) else {
            return deny(format!("missing or invalid path for {endpoint}"), &allowed);
        };
        return check_targets(&json, targets, endpoint, &allowed);
    }

    // Any other Dropbox host — in practice always `api.dropboxapi.com`.
    let Some(body) = body else {
        return deny(format!("cannot read request body for {endpoint}"), &allowed);
    };
    let Ok(json) = serde_json::from_slice::<Value>(body) else {
        return deny(format!("cannot read request body for {endpoint}"), &allowed);
    };
    let targets: &[&str] = match endpoint {
        "/2/files/move_v2" | "/2/files/copy_v2" | "/2/files/move" | "/2/files/copy" => {
            &["from_path", "to_path"]
        }
        "/2/files/search_v2" => &["options.path"],
        "/2/files/search" => &["path"],
        "/2/files/get_metadata"
        | "/2/files/list_folder"
        | "/2/files/list_folder/get_latest_cursor"
        | "/2/files/create_folder"
        | "/2/files/create_folder_v2"
        | "/2/files/delete"
        | "/2/files/delete_v2"
        | "/2/files/permanently_delete"
        | "/2/files/get_temporary_link"
        | "/2/files/list_revisions"
        | "/2/files/restore"
        | "/2/sharing/list_shared_links"
        | "/2/sharing/create_shared_link_with_settings" => &["path"],
        _ => return deny(format!("endpoint not permitted: {endpoint}"), &allowed),
    };
    check_targets(&json, targets, endpoint, &allowed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn headers_with_arg(value: &str) -> hyper::HeaderMap {
        let mut headers = hyper::HeaderMap::new();
        headers.insert("Dropbox-API-Arg", value.parse().unwrap());
        headers
    }

    fn headers_with_two_args(a: &str, b: &str) -> hyper::HeaderMap {
        let mut headers = hyper::HeaderMap::new();
        headers.append("Dropbox-API-Arg", a.parse().unwrap());
        headers.append("Dropbox-API-Arg", b.parse().unwrap());
        headers
    }

    #[test]
    fn root_boundary_means_no_restriction() {
        assert!(allowed_folders(Some(&json!({"folders": ["/"]}))).is_none());
    }

    #[test]
    fn empty_list_means_no_restriction_here_denies_everything_catches_it_earlier() {
        assert!(allowed_folders(Some(&json!({"folders": []}))).is_none());
    }

    #[test]
    fn normalizes_case_and_trailing_slash_and_drops_root() {
        let policy = json!({"folders": ["/Clients/Acme/", "/Marketing", "/"]});
        assert_eq!(
            allowed_folders(Some(&policy)),
            Some(vec!["/clients/acme".to_string(), "/marketing".to_string()])
        );
    }

    #[test]
    fn path_allowed_is_segment_bounded() {
        let allowed = vec!["/clients".to_string()];
        assert!(path_allowed("/clients", &allowed));
        assert!(path_allowed("/clients/acme", &allowed));
        assert!(!path_allowed("/clientsfoo", &allowed));
    }

    #[test]
    fn path_allowed_refuses_non_path_references() {
        let allowed = vec!["/clients".to_string()];
        assert!(!path_allowed("id:abc123", &allowed));
        assert!(!path_allowed("", &allowed));
    }

    #[test]
    fn path_allowed_refuses_rev_and_ns_references() {
        let allowed = vec!["/clients".to_string()];
        assert!(!path_allowed("rev:abc123", &allowed));
        assert!(!path_allowed("ns:456", &allowed));
    }

    #[test]
    fn path_allowed_refuses_dot_segments_and_backslashes() {
        let allowed = vec!["/clients".to_string()];
        assert!(!path_allowed("/clients/../sales/x", &allowed));
        assert!(!path_allowed("/clients/./x", &allowed));
        assert!(!path_allowed("/clients\\x", &allowed));
    }

    #[test]
    fn path_allowed_is_case_insensitive() {
        let allowed = vec!["/clients".to_string()];
        assert!(path_allowed("/CLIENTS/Acme", &allowed));
    }

    #[test]
    fn needs_body_only_for_api_host_with_folders_policy() {
        let policy = json!({"folders": ["/clients"]});
        assert!(needs_body(Some(&policy), "api.dropboxapi.com"));
        assert!(!needs_body(Some(&policy), "content.dropboxapi.com"));
        assert!(!needs_body(None, "api.dropboxapi.com"));
    }

    #[test]
    fn pathless_allowlist_passes_without_a_body() {
        let policy = json!({"folders": ["/clients"]});
        assert!(enforce(
            Some(&policy),
            "api.dropboxapi.com",
            "/2/files/list_folder/continue",
            &hyper::HeaderMap::new(),
            None,
        )
        .is_none());
    }

    #[test]
    fn in_scope_list_folder_allows() {
        let policy = json!({"folders": ["/clients"]});
        let body = json!({"path": "/clients/acme"}).to_string();
        assert!(enforce(
            Some(&policy),
            "api.dropboxapi.com",
            "/2/files/list_folder",
            &hyper::HeaderMap::new(),
            Some(body.as_bytes()),
        )
        .is_none());
    }

    #[test]
    fn out_of_scope_path_denies() {
        let policy = json!({"folders": ["/clients"]});
        let body = json!({"path": "/sales/acme"}).to_string();
        let denial = enforce(
            Some(&policy),
            "api.dropboxapi.com",
            "/2/files/list_folder",
            &hyper::HeaderMap::new(),
            Some(body.as_bytes()),
        )
        .expect("denied");
        assert_eq!(denial.rule_name, "Dropbox folder policy");
        assert_eq!(denial.allowed, vec!["/clients".to_string()]);
    }

    #[test]
    fn missing_body_denies() {
        let policy = json!({"folders": ["/clients"]});
        assert!(enforce(
            Some(&policy),
            "api.dropboxapi.com",
            "/2/files/list_folder",
            &hyper::HeaderMap::new(),
            None,
        )
        .is_some());
    }

    #[test]
    fn move_requires_both_from_and_to_path() {
        let policy = json!({"folders": ["/clients"]});
        let ok = json!({"from_path": "/clients/a", "to_path": "/clients/b"}).to_string();
        assert!(enforce(
            Some(&policy),
            "api.dropboxapi.com",
            "/2/files/move_v2",
            &hyper::HeaderMap::new(),
            Some(ok.as_bytes()),
        )
        .is_none());

        let bad = json!({"from_path": "/clients/a", "to_path": "/sales/b"}).to_string();
        assert!(enforce(
            Some(&policy),
            "api.dropboxapi.com",
            "/2/files/move_v2",
            &hyper::HeaderMap::new(),
            Some(bad.as_bytes()),
        )
        .is_some());
    }

    #[test]
    fn search_v2_without_options_path_denies() {
        let policy = json!({"folders": ["/clients"]});
        let body = json!({"options": {}}).to_string();
        assert!(enforce(
            Some(&policy),
            "api.dropboxapi.com",
            "/2/files/search_v2",
            &hyper::HeaderMap::new(),
            Some(body.as_bytes()),
        )
        .is_some());
    }

    #[test]
    fn get_latest_cursor_is_path_checked_not_pathless() {
        let policy = json!({"folders": ["/clients"]});
        let body = json!({"path": "/sales"}).to_string();
        assert!(enforce(
            Some(&policy),
            "api.dropboxapi.com",
            "/2/files/list_folder/get_latest_cursor",
            &hyper::HeaderMap::new(),
            Some(body.as_bytes()),
        )
        .is_some());
    }

    #[test]
    fn unknown_endpoint_denies() {
        let policy = json!({"folders": ["/clients"]});
        assert!(enforce(
            Some(&policy),
            "api.dropboxapi.com",
            "/2/files/list_folder/longpoll",
            &hyper::HeaderMap::new(),
            Some(b"{}"),
        )
        .is_some());
    }

    #[test]
    fn content_host_reads_the_dropbox_api_arg_header() {
        let policy = json!({"folders": ["/clients"]});
        let header = json!({"path": "/clients/acme/file.txt"}).to_string();
        assert!(enforce(
            Some(&policy),
            "content.dropboxapi.com",
            "/2/files/download",
            &headers_with_arg(&header),
            None,
        )
        .is_none());
    }

    #[test]
    fn content_host_missing_header_denies() {
        let policy = json!({"folders": ["/clients"]});
        assert!(enforce(
            Some(&policy),
            "content.dropboxapi.com",
            "/2/files/download",
            &hyper::HeaderMap::new(),
            None,
        )
        .is_some());
    }

    #[test]
    fn content_host_upload_session_finish_reads_commit_path() {
        let policy = json!({"folders": ["/clients"]});
        let header = json!({"commit": {"path": "/clients/acme/x"}}).to_string();
        assert!(enforce(
            Some(&policy),
            "content.dropboxapi.com",
            "/2/files/upload_session/finish",
            &headers_with_arg(&header),
            None,
        )
        .is_none());
    }

    // ── Coordinator review fixes (MUST-FIX 1, SHOULD 2/4) ───────────────

    #[test]
    fn duplicate_dropbox_api_arg_header_denies() {
        let policy = json!({"folders": ["/clients"]});
        let good = json!({"path": "/clients/acme/file.txt"}).to_string();
        let sneaky = json!({"path": "/sales/secret"}).to_string();
        let denial = enforce(
            Some(&policy),
            "content.dropboxapi.com",
            "/2/files/download",
            &headers_with_two_args(&good, &sneaky),
            None,
        )
        .expect("denied");
        assert_eq!(denial.reason, "ambiguous Dropbox-API-Arg");
    }

    #[test]
    fn single_dropbox_api_arg_header_allows() {
        let policy = json!({"folders": ["/clients"]});
        let header = json!({"path": "/clients/acme/file.txt"}).to_string();
        assert!(enforce(
            Some(&policy),
            "content.dropboxapi.com",
            "/2/files/download",
            &headers_with_arg(&header),
            None,
        )
        .is_none());
    }

    #[test]
    fn arg_query_parameter_on_content_host_denies() {
        let policy = json!({"folders": ["/clients"]});
        let header = json!({"path": "/clients/acme/file.txt"}).to_string();
        assert!(enforce(
            Some(&policy),
            "content.dropboxapi.com",
            "/2/files/download?arg=%7B%22path%22%3A%22%2Fsales%2Fsecret%22%7D",
            &headers_with_arg(&header),
            None,
        )
        .is_some());
    }

    #[test]
    fn arg_query_parameter_on_api_host_denies() {
        let policy = json!({"folders": ["/clients"]});
        let body = json!({"path": "/clients/acme"}).to_string();
        assert!(enforce(
            Some(&policy),
            "api.dropboxapi.com",
            "/2/files/list_folder?arg=%7B%22path%22%3A%22%2Fsales%22%7D",
            &hyper::HeaderMap::new(),
            Some(body.as_bytes()),
        )
        .is_some());
    }

    #[test]
    fn authorization_query_parameter_denies_case_insensitively() {
        let policy = json!({"folders": ["/clients"]});
        let body = json!({"path": "/clients/acme"}).to_string();
        assert!(enforce(
            Some(&policy),
            "api.dropboxapi.com",
            "/2/files/list_folder?Authorization=Bearer%20xyz",
            &hyper::HeaderMap::new(),
            Some(body.as_bytes()),
        )
        .is_some());
    }

    #[test]
    fn unrelated_query_parameter_still_allowed() {
        // Also pins query-string stripping: the endpoint match itself ignores
        // the query string entirely.
        let policy = json!({"folders": ["/clients"]});
        let body = json!({"path": "/clients/acme"}).to_string();
        assert!(enforce(
            Some(&policy),
            "api.dropboxapi.com",
            "/2/files/list_folder?foo=1",
            &hyper::HeaderMap::new(),
            Some(body.as_bytes()),
        )
        .is_none());
    }

    #[test]
    fn non_json_body_denies() {
        let policy = json!({"folders": ["/clients"]});
        assert!(enforce(
            Some(&policy),
            "api.dropboxapi.com",
            "/2/files/list_folder",
            &hyper::HeaderMap::new(),
            Some(b"not json"),
        )
        .is_some());
    }

    #[test]
    fn invalid_json_dropbox_api_arg_denies() {
        let policy = json!({"folders": ["/clients"]});
        assert!(enforce(
            Some(&policy),
            "content.dropboxapi.com",
            "/2/files/download",
            &headers_with_arg("not json"),
            None,
        )
        .is_some());
    }

    #[test]
    fn v1_and_v2_move_copy_endpoints_all_check_both_paths() {
        let policy = json!({"folders": ["/clients"]});
        for endpoint in [
            "/2/files/move_v2",
            "/2/files/copy_v2",
            "/2/files/move",
            "/2/files/copy",
        ] {
            let good = json!({"from_path": "/clients/a", "to_path": "/clients/b"}).to_string();
            assert!(
                enforce(
                    Some(&policy),
                    "api.dropboxapi.com",
                    endpoint,
                    &hyper::HeaderMap::new(),
                    Some(good.as_bytes()),
                )
                .is_none(),
                "{endpoint} should allow when both paths are in scope"
            );

            let bad_to = json!({"from_path": "/clients/a", "to_path": "/sales/b"}).to_string();
            assert!(
                enforce(
                    Some(&policy),
                    "api.dropboxapi.com",
                    endpoint,
                    &hyper::HeaderMap::new(),
                    Some(bad_to.as_bytes()),
                )
                .is_some(),
                "{endpoint} should deny an out-of-scope to_path"
            );

            let bad_from = json!({"from_path": "/sales/a", "to_path": "/clients/b"}).to_string();
            assert!(
                enforce(
                    Some(&policy),
                    "api.dropboxapi.com",
                    endpoint,
                    &hyper::HeaderMap::new(),
                    Some(bad_from.as_bytes()),
                )
                .is_some(),
                "{endpoint} should deny an out-of-scope from_path"
            );
        }
    }

    #[test]
    fn v1_search_reads_path_not_options_path() {
        let policy = json!({"folders": ["/clients"]});
        let ok = json!({"path": "/clients/acme"}).to_string();
        assert!(enforce(
            Some(&policy),
            "api.dropboxapi.com",
            "/2/files/search",
            &hyper::HeaderMap::new(),
            Some(ok.as_bytes()),
        )
        .is_none());

        let bad = json!({"path": "/sales"}).to_string();
        assert!(enforce(
            Some(&policy),
            "api.dropboxapi.com",
            "/2/files/search",
            &hyper::HeaderMap::new(),
            Some(bad.as_bytes()),
        )
        .is_some());
    }

    #[test]
    fn empty_and_root_path_values_deny() {
        let policy = json!({"folders": ["/clients"]});
        for value in ["", "/"] {
            let body = json!({"path": value}).to_string();
            assert!(
                enforce(
                    Some(&policy),
                    "api.dropboxapi.com",
                    "/2/files/list_folder",
                    &hyper::HeaderMap::new(),
                    Some(body.as_bytes()),
                )
                .is_some(),
                "path {value:?} should deny"
            );
        }
    }

    #[test]
    fn enforce_is_case_insensitive_for_targets_and_boundary() {
        let policy = json!({"folders": ["/Clients"]});
        let body = json!({"path": "/CLIENTS/Acme"}).to_string();
        assert!(enforce(
            Some(&policy),
            "api.dropboxapi.com",
            "/2/files/list_folder",
            &hyper::HeaderMap::new(),
            Some(body.as_bytes()),
        )
        .is_none());
    }

    #[test]
    fn root_folder_policy_passes_through_enforce() {
        let policy = json!({"folders": ["/"]});
        let body = json!({"path": "/anything/at/all"}).to_string();
        assert!(enforce(
            Some(&policy),
            "api.dropboxapi.com",
            "/2/files/list_folder",
            &hyper::HeaderMap::new(),
            Some(body.as_bytes()),
        )
        .is_none());
    }
}
