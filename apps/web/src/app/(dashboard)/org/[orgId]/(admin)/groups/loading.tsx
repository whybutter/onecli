import { Card } from "@onecli/ui/components/card";
import { Skeleton } from "@onecli/ui/components/skeleton";
import { PageHeader } from "@dashboard/page-header";

export default function GroupsLoading() {
  return (
    <div className="flex flex-1 flex-col gap-8">
      <PageHeader
        title="Groups"
        description="Organize members into groups, the building blocks for group-level access."
      />
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-2">
            <Skeleton className="h-5 w-32" />
            <Skeleton className="h-4 w-56" />
          </div>
          <Skeleton className="h-8 w-28 rounded-md" />
        </div>
        <Card className="p-0">
          <div className="divide-y">
            {[1, 2, 3].map((i) => (
              <div key={i} className="flex items-center justify-between p-4">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-4 w-8" />
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}
