import { ComingSoonCard } from "@/lib/components/coming-soon-card";

/**
 * Phase 0 stand-in for the claim/provisioning flow. Member provisioning and
 * claim links are permanently dropped (this fork uses invitations + Google
 * login instead — see the v2 migration plan), so this renders a plain
 * placeholder rather than resolving a claim token. Keeps the same signature
 * as the real page (`{ searchParams }`) so `app/claim/page.tsx` needs no
 * changes beyond dropping its dead entitlement branch.
 */
export default async function ClaimPage({}: {
  searchParams: Promise<{ token?: string | string[] }>;
}) {
  return (
    <ComingSoonCard
      title="Claim link"
      description="Pre-provisioned invitations are not part of this build. Ask an organization admin to send you an invite instead."
    />
  );
}
