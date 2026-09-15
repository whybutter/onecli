// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── DeleteOrgCard — role gating, per-workspace ack, confirm-by-id ──────────

const deleteOrganizationAction = vi.fn();
vi.mock("@/ee/settings/actions", () => ({
  deleteOrganizationAction: (...args: unknown[]) =>
    deleteOrganizationAction(...args),
}));

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

const toastError = vi.fn();
vi.mock("sonner", () => ({
  toast: { error: (...args: unknown[]) => toastError(...args) },
}));

import { DeleteOrgCard } from "./delete-org-card";

const WORKSPACES = [
  { id: "w1", name: "Marketing" },
  { id: "w2", name: null },
];

beforeEach(() => {
  deleteOrganizationAction.mockReset();
  push.mockReset();
  toastError.mockReset();
});
afterEach(cleanup);

const openDialog = async () => {
  const user = userEvent.setup();
  render(
    <DeleteOrgCard
      orgId="org-1"
      orgName="Acme"
      role="owner"
      workspaces={WORKSPACES}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Delete organization" }));
  return user;
};

describe("delete org card", () => {
  it("disables the trigger for a non-owner", () => {
    render(
      <DeleteOrgCard
        orgId="org-1"
        orgName="Acme"
        role="admin"
        workspaces={[]}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Delete organization" }),
    ).toBeDisabled();
  });

  it("shows an unnamed workspace as Untitled", async () => {
    await openDialog();
    expect(screen.getByText("Untitled")).toBeTruthy();
    expect(screen.getByText("Marketing")).toBeTruthy();
  });

  it("keeps the confirm button disabled until every workspace is checked and the id matches", async () => {
    const user = await openDialog();
    const confirmButton = screen.getByRole("button", {
      name: "I understand, delete this organization",
    });
    expect(confirmButton).toBeDisabled();

    await user.type(
      screen.getByPlaceholderText("Enter the organization ID"),
      "org-1",
    );
    expect(confirmButton).toBeDisabled(); // workspaces not yet acknowledged

    const checkboxes = screen.getAllByRole("checkbox");
    await user.click(checkboxes[0]!);
    await user.click(checkboxes[1]!);
    expect(confirmButton).toBeEnabled();
  });

  it("deletes and redirects on success", async () => {
    deleteOrganizationAction.mockResolvedValue({
      ok: true,
      data: { redirectTo: "/org/org-2/workspaces" },
    });
    const user = await openDialog();
    for (const checkbox of screen.getAllByRole("checkbox")) {
      await user.click(checkbox);
    }
    await user.type(
      screen.getByPlaceholderText("Enter the organization ID"),
      "org-1",
    );
    await user.click(
      screen.getByRole("button", {
        name: "I understand, delete this organization",
      }),
    );

    await waitFor(() => {
      expect(deleteOrganizationAction).toHaveBeenCalledWith("org-1");
    });
    await waitFor(() => {
      expect(push).toHaveBeenCalledWith("/org/org-2/workspaces");
    });
  });

  it("toasts the server error and stays open on failure", async () => {
    deleteOrganizationAction.mockResolvedValue({
      ok: false,
      error: "Only the organization owner can delete it",
    });
    const user = await openDialog();
    for (const checkbox of screen.getAllByRole("checkbox")) {
      await user.click(checkbox);
    }
    await user.type(
      screen.getByPlaceholderText("Enter the organization ID"),
      "org-1",
    );
    await user.click(
      screen.getByRole("button", {
        name: "I understand, delete this organization",
      }),
    );

    await waitFor(() => {
      expect(toastError).toHaveBeenCalledWith(
        "Only the organization owner can delete it",
      );
    });
    expect(push).not.toHaveBeenCalled();
  });
});
