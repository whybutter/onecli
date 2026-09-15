"use server";

import { redirect } from "next/navigation";
import { resolveOrgContext, type OrgContext } from "@/lib/actions/resolve-user";
import { requireRole } from "@onecli/api/ee/services/authorization-service";

/**
 * Server-side role guard for the org-level admin pages (Groups, Domains,
 * Organization Settings, ...). Resolves the caller's org context and
 * requires "admin" or "owner"; on ANY thrown error (forbidden or transient)
 * redirects to the org's workspace list rather than surfacing the error.
 *
 * Defense in depth beside the `(admin)` route-group layout
 * (`lib/dashboard/admin-layout.tsx`), which already gates the same pages —
 * this is the second, page-local check the v2 upstream ee pages ran before
 * touching any data.
 */
export const requireOrgAdmin = async (): Promise<OrgContext> => {
  const ctx = await resolveOrgContext();
  try {
    await requireRole(ctx.userId, ctx.organizationId, "admin");
  } catch {
    redirect(`/org/${ctx.organizationId}/workspaces`);
  }
  return ctx;
};
