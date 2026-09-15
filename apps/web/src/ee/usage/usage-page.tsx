"use client";

import { BarChart3, TriangleAlert } from "lucide-react";
import { Card } from "@onecli/ui/components/card";
import { Skeleton } from "@onecli/ui/components/skeleton";
import { PageHeader } from "@dashboard/page-header";
import { useUsage } from "@/hooks/use-usage";
import { formatPeriod } from "./_components/format";
import { RecordedRequestsInfo } from "./_components/recorded-requests-info";
import { UsageStatCard } from "./_components/usage-stat-card";
import { UsageTable } from "./_components/usage-table";

/**
 * `/org/:id/usage` — recorded gateway requests, by agent, for the current
 * organization. Member-visible (`GET /v1/org/usage` requires only `role:
 * "member"` with an org-scoped credential), fenced per-workspace
 * server-side: a member with no workspace bindings gets a zeroed summary,
 * not a 403 — so this page never renders an admin-only notice. No plan
 * strip, no quota grid, no upgrade CTA: this fork has no plan tiers.
 */
const StatSkeleton = () => (
  <Card className="gap-0 p-6">
    <Skeleton className="h-4 w-32" />
    <Skeleton className="mt-4 h-8 w-24" />
    <Skeleton className="mt-2 h-3 w-40" />
  </Card>
);

export default function UsagePage() {
  const usage = useUsage();

  return (
    <div className="flex flex-1 flex-col gap-6">
      <PageHeader
        title="Usage"
        description="Recorded gateway requests for this organization, by agent."
      />

      {usage.isPending ? (
        <div className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-2">
            <StatSkeleton />
            <StatSkeleton />
          </div>
          <Skeleton className="h-40 w-full rounded-xl" />
        </div>
      ) : usage.isError || !usage.data ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed py-12 text-center">
          <TriangleAlert className="text-muted-foreground size-6" />
          <p className="text-sm font-medium">Couldn&apos;t load usage</p>
          <p className="text-muted-foreground max-w-sm text-sm">
            Something went wrong fetching usage. Reload the page to try again.
          </p>
        </div>
      ) : (
        (() => {
          const { periodStart, periodEnd, requests, integrationCalls, agents } =
            usage.data;
          const period = formatPeriod(periodStart, periodEnd);
          return (
            <div className="space-y-6">
              <div className="grid gap-4 sm:grid-cols-2">
                {/* "recorded gateway requests", NOT "total gateway requests":
                    the gateway only writes a row when it injected a
                    credential or made a non-plain-allow policy decision, so a
                    pass-through on an agent's own key is never counted — the
                    total is not computable. */}
                <UsageStatCard
                  title="Requests this period"
                  period={period}
                  value={requests}
                  caption="recorded gateway requests"
                  titleAdornment={<RecordedRequestsInfo />}
                />
                {/* Exact, and needs no caveat: injection is precisely the
                    condition that guarantees the row exists. */}
                <UsageStatCard
                  title="Integration calls"
                  period={period}
                  value={integrationCalls}
                  caption="requests with credential injection"
                />
              </div>

              <div className="space-y-3">
                <h2 className="text-sm font-medium">Usage by agent</h2>
                {agents.length === 0 ? (
                  <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed py-12 text-center">
                    <BarChart3 className="text-muted-foreground size-6" />
                    <p className="text-muted-foreground max-w-sm text-sm">
                      Run an agent through the gateway to see its usage here.
                    </p>
                  </div>
                ) : (
                  <UsageTable agents={agents} totalRequests={requests} />
                )}
              </div>
            </div>
          );
        })()
      )}
    </div>
  );
}
