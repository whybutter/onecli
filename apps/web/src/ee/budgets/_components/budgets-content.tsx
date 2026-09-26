"use client";

import { ApiError } from "@/lib/api";
import { useBudgets } from "@/hooks/use-budgets";
import { BudgetsList } from "./budgets-list";
import { CreateBudgetDialog } from "./create-budget-dialog";

/**
 * Org-scoped spend caps, mounted under the org-scoped Global Connections
 * tabs (deliberately NOT the per-workspace connections tabs — budgets cap
 * org-owned LLM secrets only, and the create picker reads
 * `secrets.listScoped("organization")`; mounting this per-workspace would
 * 404 against every workspace-scoped secret).
 */
export const BudgetsContent = () => {
  const { data: budgets = [], isLoading, error } = useBudgets();

  // Budgets are org guardrails: only admins with an org credential may
  // manage them. A 403 is expected for members — render an admin-only
  // notice, never a raw error (critical: don't collapse the two states).
  if (error instanceof ApiError && error.status === 403) {
    return (
      <p className="text-muted-foreground text-sm">
        Spend budgets are managed by organization admins.
      </p>
    );
  }

  // Any other failure (500, network) is a real error — surface it rather
  // than falling through to the empty `budgets = []` state, which would
  // present a transport failure as "No budgets yet."
  if (error) {
    return (
      <p className="text-destructive text-sm">
        Failed to load spend budgets. Please try again.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">Spend budgets</h2>
          <p className="text-muted-foreground text-sm">
            Cap LLM spend per secret. The gateway meters token usage and blocks
            new requests once a cap is reached.
          </p>
        </div>
        <CreateBudgetDialog existing={budgets} />
      </div>

      {isLoading ? (
        <p className="text-muted-foreground text-sm">Loading budgets…</p>
      ) : budgets.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No budgets yet. Create one to cap spend on an Anthropic or OpenAI
          secret.
        </p>
      ) : (
        <BudgetsList budgets={budgets} />
      )}
    </div>
  );
};
