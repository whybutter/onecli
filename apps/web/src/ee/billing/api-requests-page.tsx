import { ComingSoonCard } from "@/lib/components/coming-soon-card";
import { requireOrgAdmin } from "@/lib/auth/require-org-admin";

/**
 * Phase 0 stand-in for the usage page (per-agent request counts, plan usage
 * ring). Usage tracking without billing behind it is scoped for a later
 * phase (the v2 migration plan's first-cut priorities list "usage page" as
 * a fork extra with no upstream twin).
 */
export default async function ApiRequestsPage() {
  await requireOrgAdmin();
  return (
    <ComingSoonCard
      title="Usage"
      description="Tracking plan usage and API requests is available in a later phase."
    />
  );
}
