//! RBAC decision-table DB tests (`gateway-ee-behaviour.md` §3.5, spec labels
//! `s14a`-`s14k`), driving `user_can_manage_workspace` / `user_is_org_admin`
//! against a real Postgres. Gated on `GATEWAY_TEST_DATABASE_URL` — see
//! `crate::test_support`.

use super::{user_can_manage_workspace, user_is_org_admin};
use crate::test_support::{
    cleanup, delete_workspace_access, seed_group, seed_group_member, seed_membership, seed_org,
    seed_user, seed_workspace, seed_workspace_access_group, seed_workspace_access_user,
    seed_workspace_with_creator, test_pool, test_prefix,
};

/// s14a: a direct `workspace_access` binding, active member — allowed.
#[tokio::test]
async fn s14a_direct_binding_allowed() {
    let Some(pool) = test_pool().await else {
        return;
    };
    let p = test_prefix("s14a");
    let (org, ws, user) = (format!("{p}-org"), format!("{p}-ws"), format!("{p}-user"));
    seed_org(&pool, &org).await;
    seed_workspace(&pool, &ws, &org).await;
    seed_user(&pool, &user).await;
    seed_membership(&pool, &org, &user, "member", "active").await;
    seed_workspace_access_user(&pool, &format!("{p}-wa"), &ws, &user, "member").await;

    assert!(
        user_can_manage_workspace(&pool, &user, &ws)
            .await
            .expect("query"),
        "a direct workspace_access binding for an active member must allow"
    );
    cleanup(&pool, &p).await;
}

/// s14b: a group binding the user belongs to, active member — allowed.
#[tokio::test]
async fn s14b_group_binding_allowed() {
    let Some(pool) = test_pool().await else {
        return;
    };
    let p = test_prefix("s14b");
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

    assert!(
        user_can_manage_workspace(&pool, &user, &ws)
            .await
            .expect("query"),
        "a workspace_access group binding covering the user via group_members must allow"
    );
    cleanup(&pool, &p).await;
}

/// s14c: org admin/owner role, no binding at all — allowed (org role
/// substitutes for a binding).
#[tokio::test]
async fn s14c_org_admin_without_binding_allowed() {
    let Some(pool) = test_pool().await else {
        return;
    };
    let p = test_prefix("s14c");
    let (org, ws, user) = (format!("{p}-org"), format!("{p}-ws"), format!("{p}-user"));
    seed_org(&pool, &org).await;
    seed_workspace(&pool, &ws, &org).await;
    seed_user(&pool, &user).await;
    seed_membership(&pool, &org, &user, "admin", "active").await;

    assert!(
        user_can_manage_workspace(&pool, &user, &ws)
            .await
            .expect("query"),
        "an org admin needs no workspace_access binding"
    );
    cleanup(&pool, &p).await;
}

/// s14d: active plain member, no binding — denied.
#[tokio::test]
async fn s14d_active_member_without_binding_denied() {
    let Some(pool) = test_pool().await else {
        return;
    };
    let p = test_prefix("s14d");
    let (org, ws, user) = (format!("{p}-org"), format!("{p}-ws"), format!("{p}-user"));
    seed_org(&pool, &org).await;
    seed_workspace(&pool, &ws, &org).await;
    seed_user(&pool, &user).await;
    seed_membership(&pool, &org, &user, "member", "active").await;

    assert!(
        !user_can_manage_workspace(&pool, &user, &ws)
            .await
            .expect("query"),
        "an active plain member with no binding must be denied"
    );
    cleanup(&pool, &p).await;
}

/// s14e: suspended member WITH a direct binding — denied. Suspension beats
/// binding.
#[tokio::test]
async fn s14e_suspended_member_with_binding_denied() {
    let Some(pool) = test_pool().await else {
        return;
    };
    let p = test_prefix("s14e");
    let (org, ws, user) = (format!("{p}-org"), format!("{p}-ws"), format!("{p}-user"));
    seed_org(&pool, &org).await;
    seed_workspace(&pool, &ws, &org).await;
    seed_user(&pool, &user).await;
    seed_membership(&pool, &org, &user, "member", "suspended").await;
    seed_workspace_access_user(&pool, &format!("{p}-wa"), &ws, &user, "member").await;

    assert!(
        !user_can_manage_workspace(&pool, &user, &ws)
            .await
            .expect("query"),
        "a suspended membership must deny even with a live binding"
    );
    cleanup(&pool, &p).await;
}

/// s14f: workspace `created_by_user_id` names the user, but they have no
/// `organization_members` row at all (removed) — denied. Pins that
/// `created_by_user_id` is pure provenance and never consulted.
#[tokio::test]
async fn s14f_removed_creator_denied() {
    let Some(pool) = test_pool().await else {
        return;
    };
    let p = test_prefix("s14f");
    let (org, ws, user) = (format!("{p}-org"), format!("{p}-ws"), format!("{p}-user"));
    seed_org(&pool, &org).await;
    seed_user(&pool, &user).await;
    seed_workspace_with_creator(&pool, &ws, &org, &user).await;
    // Deliberately no organization_members row — the creator was removed.

    assert!(
        !user_can_manage_workspace(&pool, &user, &ws)
            .await
            .expect("query"),
        "created_by_user_id must not substitute for a live membership"
    );
    cleanup(&pool, &p).await;
}

/// s14g: a binding that is deleted mid-flight must stop granting immediately
/// — no caching (Risk 1).
#[tokio::test]
async fn s14g_binding_deleted_denied_immediately() {
    let Some(pool) = test_pool().await else {
        return;
    };
    let p = test_prefix("s14g");
    let (org, ws, user) = (format!("{p}-org"), format!("{p}-ws"), format!("{p}-user"));
    let wa_id = format!("{p}-wa");
    seed_org(&pool, &org).await;
    seed_workspace(&pool, &ws, &org).await;
    seed_user(&pool, &user).await;
    seed_membership(&pool, &org, &user, "member", "active").await;
    seed_workspace_access_user(&pool, &wa_id, &ws, &user, "member").await;

    assert!(
        user_can_manage_workspace(&pool, &user, &ws)
            .await
            .expect("query"),
        "sanity: the binding must grant before deletion"
    );

    delete_workspace_access(&pool, &wa_id).await;

    assert!(
        !user_can_manage_workspace(&pool, &user, &ws)
            .await
            .expect("query"),
        "a deleted binding must deny on the very next check — no caching"
    );
    cleanup(&pool, &p).await;
}

/// s14h: an active creator with a seeded `owner`-role `workspace_access` row
/// — allowed, and specifically because the ROW exists, not because of its
/// `role` column. Usage is role-blind.
#[tokio::test]
async fn s14h_active_creator_owner_binding_role_blind_allowed() {
    let Some(pool) = test_pool().await else {
        return;
    };
    let p = test_prefix("s14h");
    let (org, ws, user) = (format!("{p}-org"), format!("{p}-ws"), format!("{p}-user"));
    seed_org(&pool, &org).await;
    seed_user(&pool, &user).await;
    seed_workspace_with_creator(&pool, &ws, &org, &user).await;
    seed_membership(&pool, &org, &user, "member", "active").await;
    // workspace_access.role = "owner" here is a MANAGEMENT role the web app
    // reads elsewhere — the gateway recheck must allow on the row's mere
    // existence, not this column.
    seed_workspace_access_user(&pool, &format!("{p}-wa"), &ws, &user, "owner").await;

    assert!(
        user_can_manage_workspace(&pool, &user, &ws)
            .await
            .expect("query"),
        "an owner-role workspace_access row must allow the same as a member-role one"
    );
    cleanup(&pool, &p).await;
}

/// s14i: a live `workspace_access` binding, but the user has never had an
/// `organization_members` row in this org at all — denied. Distinct from
/// s14f (a removed creator): here there was never a membership to begin
/// with, only a binding.
#[tokio::test]
async fn s14i_binding_without_active_membership_denied() {
    let Some(pool) = test_pool().await else {
        return;
    };
    let p = test_prefix("s14i");
    let (org, ws, user) = (format!("{p}-org"), format!("{p}-ws"), format!("{p}-user"));
    seed_org(&pool, &org).await;
    seed_workspace(&pool, &ws, &org).await;
    seed_user(&pool, &user).await;
    seed_workspace_access_user(&pool, &format!("{p}-wa"), &ws, &user, "member").await;
    // Deliberately no organization_members row.

    assert!(
        !user_can_manage_workspace(&pool, &user, &ws)
            .await
            .expect("query"),
        "a binding with no active org membership at all must deny"
    );
    cleanup(&pool, &p).await;
}

/// s14j: the user's binding is on a SIBLING workspace, not the one being
/// checked — denied.
#[tokio::test]
async fn s14j_binding_on_sibling_workspace_denied() {
    let Some(pool) = test_pool().await else {
        return;
    };
    let p = test_prefix("s14j");
    let (org, ws_a, ws_b, user) = (
        format!("{p}-org"),
        format!("{p}-ws-a"),
        format!("{p}-ws-b"),
        format!("{p}-user"),
    );
    seed_org(&pool, &org).await;
    seed_workspace(&pool, &ws_a, &org).await;
    seed_workspace(&pool, &ws_b, &org).await;
    seed_user(&pool, &user).await;
    seed_membership(&pool, &org, &user, "member", "active").await;
    // Bound to ws_b only.
    seed_workspace_access_user(&pool, &format!("{p}-wa"), &ws_b, &user, "member").await;

    assert!(
        !user_can_manage_workspace(&pool, &user, &ws_a)
            .await
            .expect("query"),
        "a binding on a sibling workspace must not grant this one"
    );
    // Sanity: it does grant the workspace it actually names.
    assert!(
        user_can_manage_workspace(&pool, &user, &ws_b)
            .await
            .expect("query"),
        "sanity: the binding does grant its own workspace"
    );
    cleanup(&pool, &p).await;
}

/// s14k: the org-admin recheck matrix — owner/admin true, plain member
/// false, suspended admin false, non-member false.
#[tokio::test]
async fn s14k_org_admin_recheck_matrix() {
    let Some(pool) = test_pool().await else {
        return;
    };
    let p = test_prefix("s14k");
    let org = format!("{p}-org");
    seed_org(&pool, &org).await;

    let owner = format!("{p}-owner");
    seed_user(&pool, &owner).await;
    seed_membership(&pool, &org, &owner, "owner", "active").await;

    let admin = format!("{p}-admin");
    seed_user(&pool, &admin).await;
    seed_membership(&pool, &org, &admin, "admin", "active").await;

    let member = format!("{p}-member");
    seed_user(&pool, &member).await;
    seed_membership(&pool, &org, &member, "member", "active").await;

    let suspended_admin = format!("{p}-susp-admin");
    seed_user(&pool, &suspended_admin).await;
    seed_membership(&pool, &org, &suspended_admin, "admin", "suspended").await;

    let non_member = format!("{p}-non-member");
    seed_user(&pool, &non_member).await;
    // No organization_members row at all.

    assert!(
        user_is_org_admin(&pool, &owner, &org).await.expect("query"),
        "an owner must recheck as org admin"
    );
    assert!(
        user_is_org_admin(&pool, &admin, &org).await.expect("query"),
        "an admin must recheck as org admin"
    );
    assert!(
        !user_is_org_admin(&pool, &member, &org)
            .await
            .expect("query"),
        "a plain member must not recheck as org admin"
    );
    assert!(
        !user_is_org_admin(&pool, &suspended_admin, &org)
            .await
            .expect("query"),
        "a suspended admin must not recheck as org admin"
    );
    assert!(
        !user_is_org_admin(&pool, &non_member, &org)
            .await
            .expect("query"),
        "a non-member must not recheck as org admin"
    );
    cleanup(&pool, &p).await;
}

/// s14l: a `workspace_access` GROUP binding naming a group from a DIFFERENT
/// organization must not grant — mirrors
/// `principals::pg_test::cross_org_group_ignored`. Before the org fence was
/// added to the group disjunct, this row granted management here while the
/// principal CTE excluded the identical row, which is exactly the
/// disagreement a security recheck must not have.
#[tokio::test]
async fn s14l_group_binding_cross_org_denied() {
    let Some(pool) = test_pool().await else {
        return;
    };
    let p = test_prefix("s14l");
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
    seed_user(&pool, &user).await;
    seed_membership(&pool, &org, &user, "member", "active").await;
    // The group belongs to the FOREIGN org but is (erroneously, or via a
    // stray write) granted to this workspace.
    seed_group(&pool, &group, &foreign_org).await;
    seed_group_member(&pool, &group, &user).await;
    seed_workspace_access_group(&pool, &format!("{p}-wa"), &ws, &group).await;

    assert!(
        !user_can_manage_workspace(&pool, &user, &ws)
            .await
            .expect("query"),
        "a workspace_access group binding naming a cross-org group must deny"
    );
    cleanup(&pool, &p).await;
}

/// Cross-org matrix: every RBAC input is per-org, so an org-A admin asking
/// about an org-B workspace must not ride the wrong org's role.
#[tokio::test]
async fn cross_org_admin_in_a_denied_for_workspace_in_b() {
    let Some(pool) = test_pool().await else {
        return;
    };
    let p = test_prefix("crossadmin");
    let (org_a, org_b, ws_b, user) = (
        format!("{p}-org-a"),
        format!("{p}-org-b"),
        format!("{p}-ws-b"),
        format!("{p}-user"),
    );
    seed_org(&pool, &org_a).await;
    seed_org(&pool, &org_b).await;
    seed_workspace(&pool, &ws_b, &org_b).await;
    seed_user(&pool, &user).await;
    // Admin of A only — no membership of any kind in B.
    seed_membership(&pool, &org_a, &user, "admin", "active").await;

    assert!(
        !user_can_manage_workspace(&pool, &user, &ws_b)
            .await
            .expect("query"),
        "an org-A admin with no membership in org B must not manage a B workspace"
    );
    cleanup(&pool, &p).await;
}

/// An admin in org A who is merely a member in org B, with no binding, must
/// still be denied a B workspace — the admin role does not travel across
/// orgs.
#[tokio::test]
async fn cross_org_admin_in_a_member_in_b_without_binding_denied() {
    let Some(pool) = test_pool().await else {
        return;
    };
    let p = test_prefix("crossmember");
    let (org_a, org_b, ws_b, user) = (
        format!("{p}-org-a"),
        format!("{p}-org-b"),
        format!("{p}-ws-b"),
        format!("{p}-user"),
    );
    seed_org(&pool, &org_a).await;
    seed_org(&pool, &org_b).await;
    seed_workspace(&pool, &ws_b, &org_b).await;
    seed_user(&pool, &user).await;
    seed_membership(&pool, &org_a, &user, "admin", "active").await;
    seed_membership(&pool, &org_b, &user, "member", "active").await;

    assert!(
        !user_can_manage_workspace(&pool, &user, &ws_b)
            .await
            .expect("query"),
        "a plain B membership with no binding must deny, regardless of an A admin role"
    );
    cleanup(&pool, &p).await;
}

/// A user active in org A but suspended in org B must be denied a B
/// workspace even with BOTH a direct and a group binding there — suspension
/// beats every binding, per-org.
#[tokio::test]
async fn cross_org_suspended_in_b_active_in_a_with_bindings_denied() {
    let Some(pool) = test_pool().await else {
        return;
    };
    let p = test_prefix("crosssuspended");
    let (org_a, org_b, ws_b, user, group) = (
        format!("{p}-org-a"),
        format!("{p}-org-b"),
        format!("{p}-ws-b"),
        format!("{p}-user"),
        format!("{p}-group"),
    );
    seed_org(&pool, &org_a).await;
    seed_org(&pool, &org_b).await;
    seed_workspace(&pool, &ws_b, &org_b).await;
    seed_user(&pool, &user).await;
    seed_membership(&pool, &org_a, &user, "member", "active").await;
    seed_membership(&pool, &org_b, &user, "member", "suspended").await;
    seed_workspace_access_user(&pool, &format!("{p}-wa-direct"), &ws_b, &user, "member").await;
    seed_group(&pool, &group, &org_b).await;
    seed_group_member(&pool, &group, &user).await;
    seed_workspace_access_group(&pool, &format!("{p}-wa-group"), &ws_b, &group).await;

    assert!(
        !user_can_manage_workspace(&pool, &user, &ws_b)
            .await
            .expect("query"),
        "suspension in B must deny even with both a direct and a group binding there"
    );
    cleanup(&pool, &p).await;
}

/// A workspace id that does not exist at all must deny — the join simply
/// produces no row.
#[tokio::test]
async fn nonexistent_workspace_denied() {
    let Some(pool) = test_pool().await else {
        return;
    };
    let p = test_prefix("noworkspace");
    let (org, user) = (format!("{p}-org"), format!("{p}-user"));
    seed_org(&pool, &org).await;
    seed_user(&pool, &user).await;
    seed_membership(&pool, &org, &user, "owner", "active").await;

    assert!(
        !user_can_manage_workspace(&pool, &user, &format!("{p}-no-such-workspace"))
            .await
            .expect("query"),
        "a nonexistent workspace must deny, even for an org owner"
    );
    cleanup(&pool, &p).await;
}
