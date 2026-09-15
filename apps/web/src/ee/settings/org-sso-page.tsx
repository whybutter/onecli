import { ComingSoonCard } from "@/lib/components/coming-soon-card";
import { requireOrgAdmin } from "@/lib/auth/require-org-admin";

/**
 * SSO/SCIM (Cognito-shaped SAML/OIDC connections) is permanently dropped in
 * this build — this fork uses Google login + email/password instead. Kept
 * as a placeholder page rather than removing the route outright, since the
 * settings sub-nav still links here; a later cleanup may drop the nav entry
 * and this route together.
 */
export default async function OrgSsoPage() {
  await requireOrgAdmin();
  return (
    <ComingSoonCard
      title="Single sign-on"
      description="This build authenticates with Google and email/password. SAML/OIDC single sign-on is not part of this build."
    />
  );
}
