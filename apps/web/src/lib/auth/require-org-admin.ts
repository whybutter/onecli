"use server";

import { redirect } from "next/navigation";
import { resolveOrgContext, type OrgContext } from "@/lib/actions/resolve-user";
import { requireRole } from "@onecli/api/ee/services/authorization-service";

/**
 * Server-side role guard for the org-level admin pages (Groups, Domains,
 * Organization Settings, ...). Resolves the caller's org context and
 * requires "admin" or "owner", failing closed on ANY thrown error rather
 * than surfacing it to the error boundary:
 *
 * - no org context can be resolved at all (not authenticated, no active
 *   membership, missing request context) → redirect home;
 * - the org IS known but the role check refuses (forbidden or a transient
 *   failure) → redirect to that org's workspace list.
 *
 * Defense in depth beside the `(admin)` route-group layout
 * (`lib/dashboard/admin-layout.tsx`), which already gates the same pages —
 * this is the second, page-local check the v2 upstream ee pages ran before
 * touching any data.
 */
export const requireOrgAdmin = async (): Promise<OrgContext> => {
  let ctx: OrgContext;
  try {
    ctx = await resolveOrgContext();
  } catch {
    redirect("/");
  }

  try {
    await requireRole(ctx.userId, ctx.organizationId, "admin");
  } catch {
    redirect(`/org/${ctx.organizationId}/workspaces`);
  }

  return ctx;
};
