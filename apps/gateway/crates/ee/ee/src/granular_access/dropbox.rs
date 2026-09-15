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
/// path (`id:…`, `rev:…`, `ns:…` references are refused), and containment is
/// segment-bounded so `/marketing` does not admit `/marketing-2024/x`.
fn path_allowed(target: &str, allowed: &[String]) -> bool {
    if !target.starts_with('/') {
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
        let Some(header_value) = headers.get("Dropbox-API-Arg").and_then(|v| v.to_str().ok())
        else {
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
}
