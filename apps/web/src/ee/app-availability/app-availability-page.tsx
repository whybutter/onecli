import { ComingSoonCard } from "@/lib/components/coming-soon-card";
import { requireOrgAdmin } from "@/lib/auth/require-org-admin";

/**
 * Phase 0 stand-in for the app-availability allowlist. Deferred per the v2
 * migration plan's Decision 3 (app availability: "not in the first cut" —
 * the gateway keeps the pure block function and an always-unrestricted
 * loader in the meantime, so every app stays available to every workspace).
 */
export default async function AppAvailabilityPage() {
  await requireOrgAdmin();
  return (
    <ComingSoonCard
      title="App Availability"
      description="Restricting which apps each workspace may connect is available in a later phase."
    />
  );
}
