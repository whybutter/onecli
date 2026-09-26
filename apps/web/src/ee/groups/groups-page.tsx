import { PageHeader } from "@dashboard/page-header";
import { requireOrgAdmin } from "@/lib/auth/require-org-admin";
import { GroupList } from "./_components/group-list";

/**
 * Directory groups (KEEP in the v2 migration plan). `requireOrgAdmin()` is
 * real defense-in-depth beside the `(admin)` route-group layout.
 *
 * Role mappings (group → org role automation) are deliberately omitted per
 * the orchestrator's vetting note 2: the `GroupRoleMapping` table has no
 * `/org/role-mappings` router mounted, so building that UI now would 404
 * every call.
 */
export default async function GroupsPage() {
  await requireOrgAdmin();
  return (
    <div className="flex flex-1 flex-col gap-8">
      <PageHeader
        title="Groups"
        description="Organize members into groups, the building blocks for group-level access."
      />
      <GroupList />
    </div>
  );
}
