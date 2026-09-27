import { apiGet, apiPost, apiPatch, apiDelete } from "./client";
import type {
  BudgetListRow,
  CreateBudgetInput,
  UpdateBudgetInput,
} from "@onecli/api/ee/services/budget-service";

export type { BudgetListRow, CreateBudgetInput, UpdateBudgetInput };

export type BudgetPeriod = CreateBudgetInput["period"];

/** `BudgetListRow.period` is a bare `string` on the wire (it's a Prisma
 * column, not a validated enum on read) — narrow it before treating it as
 * the `"monthly" | "total"` union, instead of asserting with `as`. */
export const isBudgetPeriod = (value: string): value is BudgetPeriod =>
  value === "monthly" || value === "total";

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
