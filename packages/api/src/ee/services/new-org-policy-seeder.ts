import type { NewOrgPolicySeeder } from "../../providers/hooks/new-org-policy-seeder";
import { onpremNewWorkspacePolicySeeder } from "../../services/policy-onprem-seeder";

/**
 * A new organization's policy seed. The cloud arm seeded an org-scope
 * Default Rule; this build keeps the self-hosted posture, which seeds the
 * new default WORKSPACE's published Default Rule (allow) instead.
 */
export const eeNewOrgPolicySeeder: NewOrgPolicySeeder =
  onpremNewWorkspacePolicySeeder;
