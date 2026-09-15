import { Card } from "@onecli/ui/components/card";
import { Skeleton } from "@onecli/ui/components/skeleton";
import { PageHeader } from "@dashboard/page-header";

export default function OrgGeneralLoading() {
  return (
    <div className="flex flex-1 flex-col gap-8">
      {/* Neutral description: the real page's copy branches on owner vs.
          admin, and a hardcoded owner-only line here would flash-then-swap
          for an admin once the real page loads. */}
      <PageHeader
        title="Organization"
        description="View your organization details."
      />
      <div className="flex flex-col gap-2">
        <Skeleton className="h-5 w-40" />
        <Card className="flex flex-col gap-4 p-6">
          <div className="space-y-2">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-9 w-full" />
          </div>
          <div className="space-y-2">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-9 w-full" />
          </div>
        </Card>
      </div>
    </div>
  );
}
