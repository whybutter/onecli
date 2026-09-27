"use client";

import { useState } from "react";
import { intersectPolicies } from "@onecli/api/lib/resource-axis";
import { Button } from "@onecli/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@onecli/ui/components/dialog";
import { Label } from "@onecli/ui/components/label";
import { cn } from "@onecli/ui/lib/utils";
import { granularAccessConfigs } from "@/lib/granular-access";
import type { ResourceScopeFieldsProps } from "@/lib/policy-editor/resource-scope-types";

// Re-exported for compatibility: the type itself lives in free code
// (`lib/policy-editor/resource-scope-types.ts`), the compile-time contract
// `lib/policy-editor/resource-scope.tsx` needs whatever backs this component.
export type { ResourceScopeFieldsProps } from "@/lib/policy-editor/resource-scope-types";

type Policy = Record<string, unknown> | null;

/**
 * The "Resources" row on a connection's policy: a one-line summary of which
 * repositories / folders the injected credential may reach, and a Manage
 * dialog hosting the provider's picker. Renders nothing for a provider with
 * no picker — the free wrapper shows its own hint in that case.
 *
 * The summary describes the EFFECTIVE scope — this policy composed with the
 * organization's boundary through the same `intersectPolicies` the API and
 * gateway use — so an operator reads what the credential will actually reach,
 * not just what this row asked for. Save normalises an empty selection to
 * `null`: an empty list is ambiguous at the gateway (it reads as deny-all
 * there, and the write path refuses it outright).
 */
export const ResourceScopeFields = ({
  connection,
  policy,
  onChange,
  readOnly = false,
  orgPolicy = null,
}: ResourceScopeFieldsProps) => {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Policy>(policy);

  const meta = (connection.metadata as Record<string, unknown> | null) ?? {};
  const config = granularAccessConfigs.get(connection.provider);
  const Content = config?.PolicyDialogContent;
  if (!config || !config.isSupported(meta) || !Content) return null;

  const { singular, plural } = config.itemLabel;
  const Icon = config.Icon;

  const effective = intersectPolicies(orgPolicy, policy);
  const selected = effective ? config.getSelectedItems(effective) : [];
  const emptyScope = effective !== null && selected.length === 0;

  const summary = emptyScope
    ? `No ${plural}`
    : config.formatSummary
      ? config.formatSummary(effective, meta)
      : effective !== null
        ? `${selected.length} ${selected.length === 1 ? singular : plural}`
        : `All ${plural}`;

  const openDialog = () => {
    setDraft(policy);
    setOpen(true);
  };

  const save = () => {
    const kept = draft ? config.getSelectedItems(draft) : [];
    onChange(kept.length > 0 ? draft : null);
    setOpen(false);
  };

  return (
    <div className="space-y-1.5">
      <Label>Resources</Label>
      <div className="flex items-center justify-between gap-3 rounded-md border px-3 py-2">
        <div className="flex min-w-0 items-center gap-2 text-sm">
          <Icon className="text-muted-foreground size-4 shrink-0" />
          <span
            className={cn("truncate", emptyScope && "text-destructive")}
            data-testid="resource-scope-summary"
          >
            {summary}
          </span>
        </div>
        {!readOnly && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label="Manage resources"
            onClick={openDialog}
          >
            Manage
          </Button>
        )}
      </div>
      {emptyScope ? (
        <p className="text-destructive text-xs" role="status">
          Nothing selected here is allowed by your organization, so this
          connection can&apos;t reach anything. Pick from the {plural} your
          organization allows, or ask an administrator to widen them.
        </p>
      ) : (
        <p className="text-muted-foreground text-xs">
          Limit which {plural} this connection&apos;s injected credential can
          reach
          {orgPolicy ? `, within the ${plural} your organization allows.` : "."}
        </p>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent aria-label={`Manage ${plural}`}>
          <DialogHeader>
            <DialogTitle>{connection.label ?? connection.id}</DialogTitle>
            <DialogDescription>
              Choose which {plural} this connection&apos;s credential can reach.
            </DialogDescription>
          </DialogHeader>
          <Content
            connectionId={connection.id}
            metadata={meta}
            policy={draft}
            orgBoundary={orgPolicy}
            onPolicyChange={setDraft}
            onSave={save}
            onCancel={() => setOpen(false)}
          />
        </DialogContent>
      </Dialog>
    </div>
  );
};
