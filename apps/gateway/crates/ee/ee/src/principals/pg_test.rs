//! `find_principal_set` CTE DB tests (`gateway-ee-behaviour.md` §2.3),
//! including the direct-only parity test against the free twin
//! `policy_engine::find_direct_user_principals` (reached only through the
//! test-only `policy-engine` dev-dependency — see `ee/Cargo.toml`). Gated on
//! `GATEWAY_TEST_DATABASE_URL` — see `crate::test_support`.

use super::find_principal_set;
use crate::test_support::{
    cleanup, seed_group, seed_group_member, seed_membership, seed_org, seed_user, seed_workspace,
    seed_workspace_access_group, seed_workspace_access_user, test_pool, test_prefix,
};

fn sorted(mut v: Vec<String>) -> Vec<String> {
    v.sort();
    v
}

/// A direct `workspace_access` user grant, active member — included.
#[tokio::test]
async fn direct_user_included() {
    let Some(pool) = test_pool().await else {
        return;
    };
    let p = test_prefix("direct");
    let (org, ws, user) = (format!("{p}-org"), format!("{p}-ws"), format!("{p}-user"));
    seed_org(&pool, &org).await;
    seed_workspace(&pool, &ws, &org).await;
    seed_user(&pool, &user).await;
    seed_membership(&pool, &org, &user, "member", "active").await;
    seed_workspace_access_user(&pool, &format!("{p}-wa"), &ws, &user, "member").await;

    let set = find_principal_set(&pool, &ws, &org).await.expect("query");
    assert_eq!(set.user_ids, vec![user]);
    assert!(set.group_ids.is_empty());
    cleanup(&pool, &p).await;
}

/// A directly-granted group: the group itself is a principal, and every
/// active member of it is inherited as a user principal.
#[tokio::test]
async fn via_directly_granted_group() {
    let Some(pool) = test_pool().await else {
        return;
    };
    let p = test_prefix("viagroup");
    let (org, ws, user, group) = (
        format!("{p}-org"),
        format!("{p}-ws"),
        format!("{p}-user"),
        format!("{p}-group"),
    );
    seed_org(&pool, &org).await;
    seed_workspace(&pool, &ws, &org).await;
    seed_user(&pool, &user).await;
    seed_membership(&pool, &org, &user, "member", "active").await;
    seed_group(&pool, &group, &org).await;
    seed_group_member(&pool, &group, &user).await;
    seed_workspace_access_group(&pool, &format!("{p}-wa"), &ws, &group).await;

    let set = find_principal_set(&pool, &ws, &org).await.expect("query");
    assert_eq!(set.user_ids, vec![user]);
    assert_eq!(set.group_ids, vec![group]);
    cleanup(&pool, &p).await;
}

/// A suspended member is dropped from `user_ids` even with a direct
/// binding; the directly-granted group they belong to is still a principal
/// (`direct_groups` does not depend on any member's liveness).
#[tokio::test]
async fn suspended_dropped() {
    let Some(pool) = test_pool().await else {
        return;
    };
    let p = test_prefix("suspended");
    let (org, ws, direct_user, group_user, group) = (
        format!("{p}-org"),
        format!("{p}-ws"),
        format!("{p}-direct-user"),
        format!("{p}-group-user"),
        format!("{p}-group"),
    );
    seed_org(&pool, &org).await;
    seed_workspace(&pool, &ws, &org).await;

    seed_user(&pool, &direct_user).await;
    seed_membership(&pool, &org, &direct_user, "member", "suspended").await;
    seed_workspace_access_user(&pool, &format!("{p}-wa"), &ws, &direct_user, "member").await;

    seed_user(&pool, &group_user).await;
    seed_membership(&pool, &org, &group_user, "member", "suspended").await;
    seed_group(&pool, &group, &org).await;
    seed_group_member(&pool, &group, &group_user).await;
    seed_workspace_access_group(&pool, &format!("{p}-wa-group"), &ws, &group).await;

    let set = find_principal_set(&pool, &ws, &org).await.expect("query");
    assert!(
        set.user_ids.is_empty(),
        "every candidate is suspended, so no user should resolve: {:?}",
        set.user_ids
    );
    assert_eq!(
        set.group_ids,
        vec![group],
        "a directly-granted group stays a principal even with only a suspended member"
    );
    cleanup(&pool, &p).await;
}

/// A candidate with a direct binding but NO `organization_members` row at
/// all (never a member, or fully removed) is dropped.
#[tokio::test]
async fn no_membership_dropped() {
    let Some(pool) = test_pool().await else {
        return;
    };
    let p = test_prefix("nomember");
    let (org, ws, user) = (format!("{p}-org"), format!("{p}-ws"), format!("{p}-user"));
    seed_org(&pool, &org).await;
    seed_workspace(&pool, &ws, &org).await;
    seed_user(&pool, &user).await;
    seed_workspace_access_user(&pool, &format!("{p}-wa"), &ws, &user, "member").await;
    // Deliberately no organization_members row.

    let set = find_principal_set(&pool, &ws, &org).await.expect("query");
    assert!(
        set.user_ids.is_empty(),
        "a candidate with no membership row at all must be dropped: {:?}",
        set.user_ids
    );
    cleanup(&pool, &p).await;
}

/// A `workspace_access` group grant naming a group from a DIFFERENT
/// organization is fenced out entirely — it must not contribute a group
/// principal or leak its members in as candidate users.
#[tokio::test]
async fn cross_org_group_ignored() {
    let Some(pool) = test_pool().await else {
        return;
    };
    let p = test_prefix("crossorg");
    let (org, foreign_org, ws, user, group) = (
        format!("{p}-org"),
        format!("{p}-foreign-org"),
        format!("{p}-ws"),
        format!("{p}-user"),
        format!("{p}-group"),
    );
    seed_org(&pool, &org).await;
    seed_org(&pool, &foreign_org).await;
    seed_workspace(&pool, &ws, &org).await;

    // The group belongs to the FOREIGN org, but is (erroneously, or via a
    // stray write) granted to this workspace.
    seed_group(&pool, &group, &foreign_org).await;
    seed_user(&pool, &user).await;
    seed_membership(&pool, &org, &user, "member", "active").await;
    seed_group_member(&pool, &group, &user).await;
    seed_workspace_access_group(&pool, &format!("{p}-wa"), &ws, &group).await;

    let set = find_principal_set(&pool, &ws, &org).await.expect("query");
    assert!(
        set.group_ids.is_empty(),
        "a cross-org group must be fenced out of direct_groups: {:?}",
        set.group_ids
    );
    assert!(
        set.user_ids.is_empty(),
        "the foreign group's membership must not leak in as a candidate user: {:?}",
        set.user_ids
    );
    cleanup(&pool, &p).await;
}

/// A group the user belongs to that is NOT granted to the workspace
/// directly is still added to `all_groups`, because it is a group of an
/// already-resolved user (step 4 of the CTE).
#[tokio::test]
async fn group_of_resolved_user_added() {
    let Some(pool) = test_pool().await else {
        return;
    };
    let p = test_prefix("resolvedgroup");
    let (org, ws, user, other_group) = (
        format!("{p}-org"),
        format!("{p}-ws"),
        format!("{p}-user"),
        format!("{p}-other-group"),
    );
    seed_org(&pool, &org).await;
    seed_workspace(&pool, &ws, &org).await;
    seed_user(&pool, &user).await;
    seed_membership(&pool, &org, &user, "member", "active").await;
    // Direct binding resolves the user...
    seed_workspace_access_user(&pool, &format!("{p}-wa"), &ws, &user, "member").await;
    // ...who separately belongs to a group never granted to the workspace.
    seed_group(&pool, &other_group, &org).await;
    seed_group_member(&pool, &other_group, &user).await;

    let set = find_principal_set(&pool, &ws, &org).await.expect("query");
    assert_eq!(set.user_ids, vec![user]);
    assert_eq!(
        set.group_ids,
        vec![other_group],
        "a resolved user's group must be added even without its own workspace_access grant"
    );
    cleanup(&pool, &p).await;
}

/// Parity: in a direct-only world (no groups involved anywhere), the
/// licensed CTE's user list must equal the free twin's, and the licensed
/// group list must be empty.
#[tokio::test]
async fn direct_only_parity_with_free_twin() {
    let Some(pool) = test_pool().await else {
        return;
    };
    let p = test_prefix("parity");
    let (org, ws, user_a, user_b) = (
        format!("{p}-org"),
        format!("{p}-ws"),
        format!("{p}-user-a"),
        format!("{p}-user-b"),
    );
    seed_org(&pool, &org).await;
    seed_workspace(&pool, &ws, &org).await;
    seed_user(&pool, &user_a).await;
    seed_membership(&pool, &org, &user_a, "member", "active").await;
    seed_workspace_access_user(&pool, &format!("{p}-wa-a"), &ws, &user_a, "member").await;
    seed_user(&pool, &user_b).await;
    seed_membership(&pool, &org, &user_b, "member", "active").await;
    seed_workspace_access_user(&pool, &format!("{p}-wa-b"), &ws, &user_b, "member").await;

    let licensed = find_principal_set(&pool, &ws, &org).await.expect("query");
    let free = policy_engine::find_direct_user_principals(&pool, &ws, &org)
        .await
        .expect("query (free twin)");

    assert_eq!(
        sorted(licensed.user_ids.clone()),
        sorted(free),
        "in a direct-only world the licensed CTE's users must equal the free twin's"
    );
    assert!(
        licensed.group_ids.is_empty(),
        "a direct-only world must not produce any groups: {:?}",
        licensed.group_ids
    );
    cleanup(&pool, &p).await;
}
