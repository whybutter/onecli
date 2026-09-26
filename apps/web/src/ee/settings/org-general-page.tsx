import { ComingSoonCard } from "@/lib/components/coming-soon-card";
import { requireOrgAdmin } from "@/lib/auth/require-org-admin";

/**
 * Phase 0 stand-in for Organization Settings → General (rename, ID copy,
 * owner-only delete). KEEP per the v2 migration plan, built out in Phase 3.
 */
export default async function OrgGeneralPage() {
  await requireOrgAdmin();
  return (
    <ComingSoonCard
      title="Organization"
      description="Renaming or deleting your organization is available in a later phase."
    />
  );
}
