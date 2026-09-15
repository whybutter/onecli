// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkspaceAccessCard } from "./workspace-access-card";

const state = vi.hoisted(() => ({
  data: undefined as
    | { users: { isOwner: boolean }[]; groups: unknown[] }
    | undefined,
  isPending: false,
  isError: false,
}));

vi.mock("@/hooks/use-workspace-access", () => ({
  useWorkspaceAccess: () => state,
  useSetWorkspaceAccess: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/use-org-members", () => ({
  useOrgMembersList: () => ({ data: [], isPending: false }),
}));
vi.mock("@/hooks/use-groups", () => ({
  useGroups: () => ({ data: [], isPending: false }),
}));

const reset = () => {
  state.data = undefined;
  state.isPending = false;
  state.isError = false;
};

describe("WorkspaceAccessCard", () => {
  it("shows a skeleton while sharing is loading", () => {
    reset();
    state.isPending = true;
    render(<WorkspaceAccessCard workspaceId="w1" />);
    expect(screen.getByText("Workspace access")).toBeInTheDocument();
  });

  it("shows an error message when sharing fails to load", () => {
    reset();
    state.isError = true;
    render(<WorkspaceAccessCard workspaceId="w1" />);
    expect(screen.getByText("Couldn't load sharing")).toBeInTheDocument();
  });

  it("shows 'Not shared yet' when there are no bindings", () => {
    reset();
    state.data = { users: [], groups: [] };
    render(<WorkspaceAccessCard workspaceId="w1" />);
    expect(screen.getByText("Not shared yet")).toBeInTheDocument();
  });

  it("counts people (excluding the creator) and groups", () => {
    reset();
    state.data = {
      users: [{ isOwner: true }, { isOwner: false }, { isOwner: false }],
      groups: [{}],
    };
    render(<WorkspaceAccessCard workspaceId="w1" />);
    expect(screen.getByText("2 people · 1 group")).toBeInTheDocument();
  });

  it("opens the manage-access dialog on click", async () => {
    reset();
    state.data = { users: [], groups: [] };
    render(<WorkspaceAccessCard workspaceId="w1" />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Manage access" }));
    expect(
      screen.getByRole("heading", { name: "Manage workspace access" }),
    ).toBeInTheDocument();
  });
});
