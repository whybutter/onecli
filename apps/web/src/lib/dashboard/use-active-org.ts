"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { usePathname } from "next/navigation";
import { extractOrgId } from "@/lib/org-navigation";
import { queryKeys } from "@/lib/api/keys";
import {
  getUserOrganizations,
  getActiveOrganizationId,
  type UserOrganization,
} from "@/lib/workspaces/actions";

export interface UseActiveOrgResult {
  orgs: UserOrganization[];
  activeOrg: UserOrganization | undefined;
  activeOrgId: string | null;
  setActiveOrgId: (id: string) => void;
  isLoading: boolean;
}

// Resolves the org the user is currently viewing — and their role in it.
// Query-backed (not a mount effect keyed on the URL org id) so a rename or
// any other org-facts write can invalidate `queryKeys.org.list()` and reach
// the switcher/account-menu chrome without a manual reload — the fork's own
// known mount-effect defect class (a `useEffect` fetch has no cache entry
// anything else can invalidate). The query key still incorporates the URL
// scope (via `queryKeys.org.all()`), so navigating between orgs/workspaces
// still re-fetches exactly as the old effect's `[orgId]` dependency did.
export const useActiveOrg = (): UseActiveOrgResult => {
  const pathname = usePathname();
  const orgId = extractOrgId(pathname);

  const { data, isLoading } = useQuery({
    queryKey: queryKeys.org.list(),
    queryFn: async () => {
      const [orgs, activeId] = await Promise.all([
        getUserOrganizations(),
        getActiveOrganizationId(),
      ]);
      return { orgs, activeId };
    },
  });

  // The switcher sets this optimistically (before `router.push` resolves) so
  // the highlighted org updates instantly; cleared once the URL's own org id
  // catches up to it, so a stale override can't outlive the navigation.
  const [override, setOverride] = useState<string | null>(null);
  useEffect(() => {
    if (override && orgId === override) setOverride(null);
  }, [orgId, override]);

  const orgs = data?.orgs ?? [];
  const activeOrgId = override ?? data?.activeId ?? null;
  const activeOrg = orgs.find((o) => o.id === activeOrgId);

  return {
    orgs,
    activeOrg,
    activeOrgId,
    setActiveOrgId: setOverride,
    isLoading: isLoading && !data,
  };
};
