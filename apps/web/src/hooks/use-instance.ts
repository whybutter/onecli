"use client";

import { useQuery } from "@tanstack/react-query";
import { instance } from "@/lib/api";
import { queryKeys } from "@/lib/api/keys";
import type { InstanceInfo } from "@/lib/api/types";

/**
 * Runtime instance metadata (edition + entitlement + version + hosted-agents
 * availability). `isEntitled()` is hardcoded true server-side (there is no
 * license dial in this build); `entitled` stays in the wire shape for
 * compatibility rather than as something the UI still branches on.
 * Deployment-global and near-immutable per process, hence the infinite
 * stale time.
 *
 * `poll` is for surfaces that must notice `runners.online` flipping (the chat
 * offline banner): a 30s interval on this one shared cache entry. Interval
 * refetches ignore staleTime, so polling and non-polling observers coexist.
 *
 * Returns `null` while loading — callers must treat that as "not ready yet"
 * (the same null contract as `usePlanUsage`).
 */
export const useInstance = (
  options: { poll?: boolean } = {},
): InstanceInfo | null => {
  const { data } = useQuery({
    queryKey: queryKeys.instance.all(),
    queryFn: instance.get,
    staleTime: Infinity,
    gcTime: Infinity,
    refetchInterval: options.poll ? 30_000 : undefined,
    refetchIntervalInBackground: false,
  });
  return data ?? null;
};
