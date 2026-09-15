import { Skeleton } from "@onecli/ui/components/skeleton";

export default function BudgetsTabLoading() {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-2">
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-4 w-64" />
        </div>
        <Skeleton className="h-9 w-28" />
      </div>
      <Skeleton className="h-40 w-full rounded-lg" />
    </div>
  );
}
