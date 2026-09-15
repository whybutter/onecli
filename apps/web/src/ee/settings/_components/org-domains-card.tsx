"use client";

import { useState } from "react";
import { Globe, Loader2, Trash2 } from "lucide-react";
import { Card } from "@onecli/ui/components/card";
import { Button } from "@onecli/ui/components/button";
import { Input } from "@onecli/ui/components/input";
import { Label } from "@onecli/ui/components/label";
import { Badge } from "@onecli/ui/components/badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@onecli/ui/components/alert-dialog";
import type { OrgDomain } from "@/lib/api/types";
import {
  useDomains,
  useCreateDomain,
  useVerifyDomain,
  useDeleteDomain,
} from "@/hooks/use-domains";
import { DomainTxtRecord } from "./domain-txt-record";

/** Claim and verify the organization's email domains via DNS TXT record. */
export const OrgDomainsCard = () => {
  const { data: domains, isPending } = useDomains();
  const createDomain = useCreateDomain();
  const verifyDomain = useVerifyDomain();
  const deleteDomain = useDeleteDomain();

  const [input, setInput] = useState("");
  const [removeTarget, setRemoveTarget] = useState<OrgDomain | null>(null);

  const handleAdd = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = input.trim();
    if (!trimmed) return;
    createDomain.mutate(trimmed, {
      onSuccess: () => setInput(""),
    });
  };

  const rows = domains ?? [];

  return (
    <>
      <Card className="flex flex-col gap-4 p-6">
        <form onSubmit={handleAdd} className="flex flex-col gap-2">
          <Label htmlFor="domain-input">Add a domain</Label>
          <div className="flex max-w-sm gap-2">
            <Input
              id="domain-input"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="example.com"
            />
            <Button
              type="submit"
              loading={createDomain.isPending}
              disabled={!input.trim() || createDomain.isPending}
            >
              {createDomain.isPending ? "Adding..." : "Add domain"}
            </Button>
          </div>
          <p className="text-muted-foreground text-xs">
            You&apos;ll prove ownership by publishing a DNS TXT record.
          </p>
        </form>

        {isPending ? (
          <p className="text-muted-foreground text-sm">Loading domains...</p>
        ) : rows.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-md border border-dashed py-10 text-center">
            <Globe className="text-muted-foreground size-6" />
            <p className="text-sm font-medium">No domains yet</p>
            <p className="text-muted-foreground max-w-xs text-xs">
              Claim your company domain.
            </p>
          </div>
        ) : (
          <div className="divide-y rounded-md border">
            {rows.map((domain) => {
              const verified = !!domain.verifiedAt;
              const verifying =
                verifyDomain.isPending && verifyDomain.variables === domain.id;
              return (
                <div key={domain.id} className="flex flex-col gap-1 p-4">
                  <div className="flex items-center justify-between gap-4">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">
                        {domain.domain}
                      </span>
                      {verified ? (
                        <Badge className="bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
                          Verified
                        </Badge>
                      ) : (
                        <Badge variant="secondary">Pending</Badge>
                      )}
                    </div>
                    <div className="flex items-center gap-1">
                      {!verified && (
                        <Button
                          variant="outline"
                          size="sm"
                          loading={verifying}
                          disabled={verifyDomain.isPending}
                          onClick={() => verifyDomain.mutate(domain.id)}
                        >
                          {verifying ? "Checking..." : "Verify"}
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Remove ${domain.domain}`}
                        onClick={() => setRemoveTarget(domain)}
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  </div>
                  {!verified && <DomainTxtRecord domain={domain} />}
                </div>
              );
            })}
          </div>
        )}
      </Card>

      <AlertDialog
        open={!!removeTarget}
        onOpenChange={(open) => !open && setRemoveTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {removeTarget?.domain}?</AlertDialogTitle>
            <AlertDialogDescription>
              The domain loses its verification. You&apos;ll need to re-verify
              it before claiming it again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteDomain.isPending}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                if (!removeTarget) return;
                deleteDomain.mutate(removeTarget.id, {
                  onSuccess: () => setRemoveTarget(null),
                });
              }}
              disabled={deleteDomain.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleteDomain.isPending ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Removing...
                </>
              ) : (
                "Remove"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};
