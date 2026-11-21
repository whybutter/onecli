import { db } from "@onecli/db";
import type { AppAvailabilityProvider } from "../../providers/types";
import { resolvePrincipalSet } from "../../services/policy-simulate/principal-set";

export const appAvailability: AppAvailabilityProvider = {
  async getAvailableProviders(workspaceId, organizationId) {
    const workspace = await db.workspace.findFirst({
      where: { id: workspaceId, organizationId },
      select: { organization: { select: { appAvailabilityMode: true } } },
    });
    if (!workspace) return [];
    if (workspace.organization.appAvailabilityMode === "open") return null;
    const { userIds, groupIds } = await resolvePrincipalSet(
      workspaceId,
      organizationId,
    );
    const rules = await db.appAvailabilityRule.findMany({
      where: {
        organizationId,
        identities: {
          some: {
            OR: [{ userId: { in: userIds } }, { groupId: { in: groupIds } }],
          },
        },
      },
      select: { providers: true },
    });
    return [...new Set(rules.flatMap((rule) => rule.providers))];
  },
};
