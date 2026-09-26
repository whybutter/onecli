import { db } from "@onecli/db";
import { EFFECTIVE_PLAN, type Plan } from "../billing/plans";
import type { PremiumFeature } from "../billing/plan-features";

/**
 * Quotas collapsed to the non-billing branch: nothing is capped. The
 * functions stay so the free callers (the workspaces page, the create
 * action, the hook-side asserts) keep their shape; each is a no-op that
 * runs zero queries, except `getWorkspaceQuota`, whose count the UI shows.
 *
 * There is deliberately no organization cap either (v2 migration decision
 * 2): any user may create organizations.
 */

export interface WorkspaceQuota {
  current: number;
  limit: number;
  plan: Plan;
}

export const getWorkspaceQuota = async (
  organizationId: string,
): Promise<WorkspaceQuota> => ({
  current: await db.workspace.count({ where: { organizationId } }),
  limit: Number.POSITIVE_INFINITY,
  plan: EFFECTIVE_PLAN,
});

type OrgAssert = (organizationId: string) => Promise<void>;
type UserAssert = (userId: string) => Promise<void>;

const pass: OrgAssert & UserAssert = async () => {};

export const assertCanCreateWorkspace: OrgAssert = pass;

export const assertCanCreateOrganization: UserAssert = pass;

export const canCreateOrganization: (
  userId: string,
) => Promise<boolean> = async () => true;

export const assertCanCreateAgent: (
  organizationId: string,
  workspaceId?: string,
) => Promise<void> = pass;

export const assertCanCreateSecret: OrgAssert = pass;

export const assertCanCreateOAuthApp: OrgAssert = pass;

export const assertCanInviteMember: OrgAssert = pass;

export const assertFeatureAllowed: (
  organizationId: string,
  feature: PremiumFeature,
) => Promise<void> = pass;

export const assertCanUseGranularAccess: OrgAssert = pass;

export const assertCanShareWorkspace: OrgAssert = pass;
