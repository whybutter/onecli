import { apiGet, apiPost, apiPatch, apiDelete } from "./client";
import type {
  BudgetListRow,
  CreateBudgetInput,
  UpdateBudgetInput,
} from "@onecli/api/ee/services/budget-service";

export type { BudgetListRow, CreateBudgetInput, UpdateBudgetInput };

// Spend budgets are ORG guardrails: always `/v1/org/budgets` (admin-gated,
// requireWorkspace: false). A budget caps spend on a metered LLM secret the
// org owns; the gateway enforces it (see apps/gateway/src/budget.rs). Wire
// shapes come straight from the route's own service export — no local
// `Budget` interface to drift from it.
const base = "/v1/org/budgets";

export const list = () => apiGet<BudgetListRow[]>(base);

export const create = (input: CreateBudgetInput) =>
  apiPost<BudgetListRow>(base, input);

export const update = (id: string, input: UpdateBudgetInput) =>
  apiPatch<BudgetListRow>(`${base}/${id}`, input);

export const remove = (id: string) => apiDelete(`${base}/${id}`);
