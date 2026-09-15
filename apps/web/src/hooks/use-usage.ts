"use client";

import { useQuery } from "@tanstack/react-query";
import * as usageApi from "@/lib/api/usage";
import { queryKeys } from "@/lib/api/keys";

/**
 * Recorded gateway request volume for the org (`GET /v1/org/usage`) —
 * member-visible with per-workspace fencing server-side. A member with no
 * workspace bindings gets a zeroed summary, not a 403, so `retry: false`
 * exists only to avoid retrying a real refusal (a workspace-scoped
 * credential, which the web app's cookie session never presents).
 */
export const useUsage = () =>
  useQuery({
    queryKey: queryKeys.usage.summary(),
    queryFn: usageApi.get,
    retry: false,
  });
