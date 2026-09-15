import { PageHeader } from "@dashboard/page-header";
import { requireOrgAdmin } from "@/lib/auth/require-org-admin";
import { getOrganizationData } from "./actions";
import { OrgDetailsForm } from "./_components/org-details-form";
import { DeleteOrgCard } from "./_components/delete-org-card";

/**
 * Organization settings → General: rename, ID copy, owner-only delete.
 *
 * Gated on OWNER for editing (not admin): `PATCH /v1/org` is owner-only
 * server-side (`routes/org.ts`), so an admin-editable form would 403 on
 * save. This fixes the upstream mismatch `web-ee-behaviour.md` §1.3 calls
 * out (its page let admins edit while its action rejected them) — the
 * server is the source of truth here.
 */
export default async function OrgGeneralPage() {
  await requireOrgAdmin();
  const org = await getOrganizationData();

  if (!org) {
    return (
      <PageHeader
        title="Organization"
        description="You are not part of any organization."
      />
    );
  }

  const isOwner = org.role === "owner";

  return (
    <div className="flex flex-1 flex-col gap-8">
      <PageHeader
        title="Organization"
        description={
          isOwner
            ? "Rename or delete your organization."
            : "View your organization details."
        }
      />

      <div className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">Organization details</h2>
        <OrgDetailsForm orgId={org.id} orgName={org.name} readOnly={!isOwner} />
      </div>

      {isOwner && (
        <div className="flex flex-col gap-2">
          <h2 className="text-lg font-semibold">Danger zone</h2>
          <DeleteOrgCard
            orgId={org.id}
            orgName={org.name}
            role={org.role}
            workspaces={org.workspaces}
          />
        </div>
      )}
    </div>
  );
}
