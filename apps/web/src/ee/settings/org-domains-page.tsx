import { PageHeader } from "@dashboard/page-header";
import { requireOrgAdmin } from "@/lib/auth/require-org-admin";
import { OrgDomainsCard } from "./_components/org-domains-card";

/**
 * Organization settings → Domains (DNS TXT verification). No SSO-referencing
 * copy anywhere — SSO/SCIM are permanently dropped in this fork.
 */
export default async function OrgDomainsPage() {
  await requireOrgAdmin();
  return (
    <div className="flex flex-1 flex-col gap-4">
      <PageHeader
        title="Domains"
        description="Claim your company's email domains and verify them via DNS."
      />
      <OrgDomainsCard />
    </div>
  );
}
