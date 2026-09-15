import { Skeleton } from "@onecli/ui/components/skeleton";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
} from "@onecli/ui/components/card";

/** Mirrors `CreateOrgForm`'s card: title, two-line blurb, label + field +
 * helper, right-aligned submit — so nothing shifts when the form lands. */
export default function CreateOrgLoading() {
  return (
    <Card className="w-full max-w-lg" aria-busy="true" aria-label="Loading">
      <CardHeader className="space-y-2">
        <Skeleton className="h-6 w-64" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-3/4" />
      </CardHeader>
      <CardContent className="space-y-2 pt-4">
        <Skeleton className="h-4 w-12" />
        <Skeleton className="h-9 w-full rounded-md" />
        <Skeleton className="h-3 w-80" />
      </CardContent>
      <CardFooter className="justify-end pt-4">
        <Skeleton className="h-9 w-40 rounded-md" />
      </CardFooter>
    </Card>
  );
}
