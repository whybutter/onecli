import { ComingSoonCard } from "@/lib/components/coming-soon-card";
import { requireOrgAdmin } from "@/lib/auth/require-org-admin";

/**
 * Phase 0 stand-in for Organization Settings → Domains (DNS TXT domain
 * verification). KEEP per the v2 migration plan, built out in Phase 3.
 */
export default async function OrgDomainsPage() {
  await requireOrgAdmin();
  return (
    <ComingSoonCard
      title="Domains"
      description="Claiming and verifying your organization's email domains is available in a later phase."
    />
  );
}
