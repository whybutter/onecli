// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkspaceAccessDialog } from "./workspace-access-dialog";

// Radix Select needs the pointer-capture surface jsdom lacks; without these
// stubs the portal never opens and every option query is a false miss.
beforeAll(() => {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
  Element.prototype.scrollIntoView = () => {};
});

const state = vi.hoisted(() => ({
  access: {
    data: {
      users: [
        {
          id: "b1",
          userId: "u1",
          name: "Ada Creator",
          email: "ada@example.com",
          role: "owner" as const,
          isOwner: true,
          createdAt: "2026-01-01",
        },
      ],
      groups: [],
    },
    isPending: false,
    isError: false,
  },
  members: {
    data: [
      {
        userId: "u1",
        email: "ada@example.com",
        name: "Ada Creator",
        role: "owner",
        status: "active",
        ssoExempt: false,
        joinedAt: "2026-01-01",
      },
      {
        userId: "u2",
        email: "bob@example.com",
        name: "Bob Member",
        role: "member",
        status: "active",
        ssoExempt: false,
        joinedAt: "2026-01-01",
      },
    ],
    isPending: false,
  },
  groups: { data: [], isPending: false },
}));

const saveMock = vi.hoisted(() =>
  vi.fn((_input: unknown, opts?: { onSuccess?: () => void }) => {
    opts?.onSuccess?.();
  }),
);

vi.mock("@/hooks/use-workspace-access", () => ({
  useWorkspaceAccess: () => state.access,
  useSetWorkspaceAccess: () => ({ mutate: saveMock, isPending: false }),
}));
vi.mock("@/hooks/use-org-members", () => ({
  useOrgMembersList: () => state.members,
}));
vi.mock("@/hooks/use-groups", () => ({
  useGroups: () => state.groups,
}));

const toastSuccess = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({ toast: { success: toastSuccess, error: vi.fn() } }));

describe("WorkspaceAccessDialog", () => {
  beforeEach(() => {
    saveMock.mockClear();
    toastSuccess.mockClear();
  });

  it("seeds from the current bindings and disables Save until dirty", () => {
    render(
      <WorkspaceAccessDialog workspaceId="w1" open onOpenChange={vi.fn()} />,
    );
    expect(screen.getByText("Creator")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("enables Save once a selection changes, and saves on click", async () => {
    render(
      <WorkspaceAccessDialog workspaceId="w1" open onOpenChange={vi.fn()} />,
    );
    const user = userEvent.setup();
    await user.click(
      screen.getByRole("checkbox", { name: "Share with Bob Member" }),
    );
    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toBeEnabled();
    await user.click(save);
    expect(saveMock).toHaveBeenCalled();
    expect(toastSuccess).toHaveBeenCalledWith("Workspace access updated");
  });

  it("shows the no-one-will-be-able warning once every binding is removed", async () => {
    render(
      <WorkspaceAccessDialog workspaceId="w1" open onOpenChange={vi.fn()} />,
    );
    const user = userEvent.setup();
    await user.click(
      screen.getByRole("checkbox", { name: "Share with Ada Creator" }),
    );
    expect(
      screen.getByText(/No one will be able to use this workspace/),
    ).toBeInTheDocument();
  });

  it("shows the no-owner warning when bindings exist but nobody has the owner role", async () => {
    render(
      <WorkspaceAccessDialog workspaceId="w1" open onOpenChange={vi.fn()} />,
    );
    const user = userEvent.setup();
    // Demote the seeded owner to member — bindings remain, but no owner.
    await user.click(
      screen.getByRole("combobox", { name: "Role for Ada Creator" }),
    );
    await user.click(await screen.findByRole("option", { name: "Member" }));
    expect(screen.getByText(/No workspace owner set/)).toBeInTheDocument();
  });

  it("renders a load failure without an editable body", () => {
    state.access.isError = true;
    render(
      <WorkspaceAccessDialog workspaceId="w1" open onOpenChange={vi.fn()} />,
    );
    expect(screen.getByText("Couldn't load access")).toBeInTheDocument();
    expect(screen.queryByText("People")).not.toBeInTheDocument();
    state.access.isError = false;
  });
});
