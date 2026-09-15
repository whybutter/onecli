import { apiGet } from "./client";
import type { OrgUsageResponse } from "@onecli/api/ee/routes/org-usage";

export type { OrgUsageResponse };
export type { UsageAgentRow } from "@onecli/api/ee/services/usage-service";

// Org-scoped recorded-gateway-request volume (`/v1/org/usage`). Member-
// visible with per-workspace fencing server-side — NOT admin-only like
// budgets/members/groups/domains — but still requires an org-scoped
// credential (a workspace-scoped key gets a 403; the web app always
// authenticates via cookie session, which resolves org context server-side,
// so this never surfaces in normal use).
export const get = () => apiGet<OrgUsageResponse>("/v1/org/usage");
