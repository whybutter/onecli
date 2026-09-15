// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ApiError } from "@/lib/api/client";
import { BudgetsContent } from "./budgets-content";

const state = vi.hoisted(() => ({
  data: undefined as unknown[] | undefined,
  isLoading: false,
  error: null as Error | null,
}));

vi.mock("@/hooks/use-budgets", () => ({
  useBudgets: () => state,
  useMeteredSecrets: () => ({ data: [], isLoading: false }),
  useCreateBudget: () => ({ mutate: vi.fn(), isPending: false }),
}));

const reset = () => {
  state.data = undefined;
  state.isLoading = false;
  state.error = null;
};

describe("BudgetsContent", () => {
  it("shows an admin-only notice on a 403 — never a raw error", () => {
    reset();
    state.error = new ApiError("Forbidden", 403);
    render(<BudgetsContent />);
    expect(
      screen.getByText("Spend budgets are managed by organization admins."),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Failed to load spend budgets. Please try again."),
    ).not.toBeInTheDocument();
  });

  it("shows a real error distinctly from the 403 admin-only notice", () => {
    reset();
    state.error = new ApiError("Internal error", 500);
    render(<BudgetsContent />);
    expect(
      screen.getByText("Failed to load spend budgets. Please try again."),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Spend budgets are managed by organization admins."),
    ).not.toBeInTheDocument();
  });

  it("shows an empty state distinctly from either error state", () => {
    reset();
    state.data = [];
    render(<BudgetsContent />);
    expect(
      screen.getByText(
        "No budgets yet. Create one to cap spend on an Anthropic or OpenAI secret.",
      ),
    ).toBeInTheDocument();
  });
});
