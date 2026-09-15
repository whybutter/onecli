import { ComingSoonCard } from "@/lib/components/coming-soon-card";
import { requireOrgAdmin } from "@/lib/auth/require-org-admin";

/**
 * Phase 0 stand-in for Directory groups (KEEP in the v2 migration plan, but
 * a Phase 3 build-out). `requireOrgAdmin()` is real defense-in-depth beside
 * the `(admin)` route-group layout, matching the upstream page's guard
 * sequence even though this page has nothing behind it yet.
 */
export default async function GroupsPage() {
  await requireOrgAdmin();
  return (
    <ComingSoonCard
      title="Groups"
      description="Organizing members into directory groups and mapping groups to org roles is available in a later phase."
    />
  );
}
