"use client";

import { useState } from "react";
import {
  RefreshCw,
  Eye,
  EyeOff,
  Copy,
  Check,
  Info,
  Loader2,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@onecli/ui/components/card";
import { Button } from "@onecli/ui/components/button";
import { Skeleton } from "@onecli/ui/components/skeleton";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@onecli/ui/components/alert-dialog";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { maskSecret } from "@/lib/mask-secret";
import { DOCS_URL } from "@/lib/components/docs-link";
import {
  useRegenerateWorkspaceApiKey,
  useWorkspaceApiKey,
} from "@/hooks/use-workspace-api-key";

/** "3 minutes ago" / "2 days ago" — coarse enough that timing skew across the
 *  server-render/client boundary never matters. */
const formatRelativeTime = (iso: string): string => {
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["year", 60 * 60 * 24 * 365],
    ["month", 60 * 60 * 24 * 30],
    ["day", 60 * 60 * 24],
    ["hour", 60 * 60],
    ["minute", 60],
  ];
  for (const [unit, unitSeconds] of units) {
    const value = Math.floor(seconds / unitSeconds);
    if (value >= 1) {
      return new Intl.RelativeTimeFormat("en-US", { numeric: "auto" }).format(
        -value,
        unit,
      );
    }
  }
  return "just now";
};

export const WorkspaceApiKeyCard = () => {
  const { data, isPending, isError } = useWorkspaceApiKey();
  const regenerate = useRegenerateWorkspaceApiKey();
  const [revealed, setRevealed] = useState(false);
  const { copied, copy } = useCopyToClipboard();

  const apiKey = data?.apiKey ?? "";
  const truncatedKey = apiKey ? maskSecret(apiKey) : "";

  return (
    <Card>
      <CardHeader>
        <CardTitle>Your API Key</CardTitle>
        <CardDescription>
          Personal to you and scoped to this workspace. Requests made with it
          are attributed to you. Install uses it in its sign-in command.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center gap-2">
          {isPending ? (
            <Skeleton className="h-9 flex-1 rounded-md" />
          ) : (
            <code className="bg-muted min-w-0 flex-1 truncate rounded-md border px-3 py-2 font-mono text-sm select-none">
              {isError || !apiKey ? (
                <span className="text-muted-foreground">
                  Couldn&apos;t load your API key. Reload to try again.
                </span>
              ) : revealed ? (
                apiKey
              ) : (
                truncatedKey
              )}
            </code>
          )}
          <Button
            variant="ghost"
            size="icon"
            aria-label={revealed ? "Hide API key" : "Reveal API key"}
            onClick={() => setRevealed(!revealed)}
            disabled={isPending || !apiKey}
          >
            {revealed ? (
              <EyeOff className="size-4" />
            ) : (
              <Eye className="size-4" />
            )}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Copy API key"
            onClick={() => copy(apiKey)}
            disabled={isPending || !apiKey}
          >
            {copied ? (
              <Check className="text-brand size-4" />
            ) : (
              <Copy className="size-4" />
            )}
          </Button>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Regenerate API key"
                disabled={isPending || regenerate.isPending || !apiKey}
              >
                {regenerate.isPending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <RefreshCw className="size-4" />
                )}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Regenerate API key?</AlertDialogTitle>
                <AlertDialogDescription>
                  The current API key will be invalidated immediately. Any CLI,
                  SDK, or service using the old key will lose access until you
                  sign it in again with the new one.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                {/* The action closes the dialog on click; the trigger's
                    spinner carries the pending state from there. */}
                <AlertDialogAction
                  onClick={() =>
                    regenerate.mutate(undefined, {
                      onSuccess: () => setRevealed(true),
                    })
                  }
                >
                  Regenerate
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
        {!isPending && !isError && apiKey && (
          <p className="text-muted-foreground text-xs">
            {data?.lastUsedAt
              ? `Last used ${formatRelativeTime(data.lastUsedAt)}`
              : "Never used"}
          </p>
        )}
        <div className="text-muted-foreground flex items-start gap-2 text-xs">
          <Info className="mt-0.5 size-3 shrink-0" />
          <span>
            Send it as{" "}
            <code className="bg-muted rounded px-1 py-0.5">
              Authorization: Bearer oc_...
            </code>
            .{" "}
            <a
              href={`${DOCS_URL}/api-reference#workspace-keys`}
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-foreground underline underline-offset-2"
            >
              Workspace keys in the docs
            </a>
          </span>
        </div>
      </CardContent>
    </Card>
  );
};
