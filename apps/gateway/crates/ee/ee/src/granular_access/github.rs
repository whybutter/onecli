//! GitHub App token-level scoping: mint an installation access token
//! restricted to a specific repository list, so the request-forwarding path
//! never needs to inspect GitHub calls at all (`has_request_guard` is false
//! for this provider — there is nothing for it to check).
//!
//! `docs/upstream-sync/v2-migration/gateway-ee-behaviour.md` §1.7. The actual
//! GitHub API call (JWT signing, the installation-token exchange) already
//! lives in the free `apps` crate (`apps::refresh_github_app_token`) — this
//! module only decides WHETHER and WITH WHAT repository list to call it.

use serde_json::Value;

/// The credential-payload `type` this scoper answers for — keyed by
/// credential type, not provider name (a GitHub connection's `provider` is
/// `"github-app"`; its credential JSON's `type` is `"github_app"`).
const CRED_TYPE: &str = "github_app";

pub(super) fn has_scoper(cred_type: &str) -> bool {
    cred_type == CRED_TYPE
}

/// The policy's `repositories` list, as raw strings (not yet lowercased —
/// GitHub App installation tokens accept the caller's casing). `None` when
/// the key is absent or its value isn't an array.
fn repositories(policy: Option<&Value>) -> Option<Vec<String>> {
    let obj = policy?.as_object()?;
    let entries = obj.get("repositories")?.as_array()?;
    Some(
        entries
            .iter()
            .filter_map(|v| v.as_str().map(str::to_string))
            .collect(),
    )
}

/// Attempt a scoped mint for a GitHub App credential. See the decision table
/// in `gateway-ee-behaviour.md` §1.7:
/// - No usable repository list, and the policy doesn't explicitly deny
///   everything → `None` (fall through to the ordinary, unscoped refresh).
/// - Repository list explicitly empty (`denies_everything`) → an `Err`,
///   defense in depth (normally intercepted earlier by `refuse_empty_scope`).
/// - Non-empty list, incomplete credentials → an `Err`.
/// - Non-empty list, complete credentials → the shared installation-token
///   mint, scoped to the list.
pub(super) async fn scope(
    creds: &Value,
    policy: Option<&Value>,
) -> Option<anyhow::Result<(String, i64)>> {
    let Some(repos) = repositories(policy).filter(|r| !r.is_empty()) else {
        if super::denies_everything(policy) {
            return Some(Err(anyhow::anyhow!(
                "empty repository allowlist denies all access; refusing to mint an unscoped token"
            )));
        }
        return None;
    };

    let private_key = creds.get("private_key").and_then(Value::as_str);
    let app_id = creds.get("app_id").and_then(Value::as_str);
    let installation_id = creds.get("installation_id").and_then(Value::as_str);

    let (Some(private_key), Some(app_id), Some(installation_id)) =
        (private_key, app_id, installation_id)
    else {
        return Some(Err(anyhow::anyhow!(
            "GitHub App credentials incomplete, cannot refresh"
        )));
    };

    Some(apps::refresh_github_app_token(private_key, app_id, installation_id, Some(&repos)).await)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn has_scoper_only_for_github_app() {
        assert!(has_scoper("github_app"));
        assert!(!has_scoper("dropbox"));
        assert!(!has_scoper("oauth"));
    }

    #[tokio::test]
    async fn no_policy_falls_through() {
        assert!(scope(&json!({}), None).await.is_none());
    }

    #[tokio::test]
    async fn non_array_repositories_falls_through() {
        let policy = json!({"repositories": "org/a"});
        assert!(scope(&json!({}), Some(&policy)).await.is_none());
    }

    #[tokio::test]
    async fn empty_repositories_refuses_to_mint() {
        let policy = json!({"repositories": []});
        let result = scope(&json!({}), Some(&policy)).await;
        assert!(result.unwrap().is_err());
    }

    #[tokio::test]
    async fn incomplete_credentials_error() {
        let policy = json!({"repositories": ["org/a"]});
        let creds = json!({"app_id": "1"}); // missing private_key/installation_id
        let result = scope(&creds, Some(&policy)).await;
        assert!(result.unwrap().is_err());
    }
}
