import { ComingSoonCard } from "@/lib/components/coming-soon-card";

/**
 * Phase 0 stand-in for the create-org form. Multi-org has no cap in this
 * fork (v2 migration plan Decision 2), but the create-org UI itself ships
 * in Phase 3.
 */
export default async function CreateOrgPage() {
  return (
    <ComingSoonCard
      title="Create organization"
      description="Creating additional organizations is available in a later phase."
    />
  );
}
