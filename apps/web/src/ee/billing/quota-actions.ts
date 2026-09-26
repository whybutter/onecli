"use server";

import { resolveOrgContext } from "@/lib/actions/resolve-user";

export interface ResourceQuota {
  current: number;
  limit: number;
  plan: string;
  atLimit: boolean;
  organizationId: string;
}

/**
 * There is no quota service in this build (Decision 2 of the v2 migration
 * plan: no cap on organizations, and plan-based resource caps went with
 * billing). Always reports "unlimited, not at limit" so the free create
 * buttons (agents, secrets, invites) never block. `organizationId` is best-
 * effort — the callers only read it to build a "manage plan" link, which is
 * itself dead code once `atLimit` is always false.
 */
export const getResourceQuota: (
  resourceName: string,
) => Promise<ResourceQuota> = async () => {
  let organizationId = "";
  try {
    ({ organizationId } = await resolveOrgContext());
  } catch {
    // No org context yet (e.g. called before bootstrap) — quota is still
    // reported as unlimited, so callers proceed regardless.
  }
  return {
    current: 0,
    limit: Number.POSITIVE_INFINITY,
    plan: "enterprise",
    atLimit: false,
    organizationId,
  };
};
