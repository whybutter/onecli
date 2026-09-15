import { Card } from "@onecli/ui/components/card";
import { Skeleton } from "@onecli/ui/components/skeleton";
import { PageHeader } from "@dashboard/page-header";

export default function DomainsLoading() {
  return (
    <div className="flex flex-1 flex-col gap-4">
      <PageHeader
        title="Domains"
        description="Claim your company's email domains and verify them via DNS."
      />
      <Card className="flex flex-col gap-4 p-6">
        <div className="max-w-sm space-y-2">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-9 w-full" />
        </div>
        <div className="space-y-2">
          {[1, 2].map((i) => (
            <Skeleton key={i} className="h-14 w-full rounded-md" />
          ))}
        </div>
      </Card>
    </div>
  );
}
