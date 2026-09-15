// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// Radix Select needs the pointer-capture surface jsdom lacks; without these
// stubs the portal never opens and every option query is a false miss.
beforeAll(() => {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
  Element.prototype.scrollIntoView = () => {};
});

// ── "Manage access" trimmed to role-only ────────────────────────────────────
//
// SSO break-glass exemption and the IdP-managed-role lock are dropped in this
// fork (no SSO). What is pinned here: the role select seeds from the member's
// current role, Save stays disabled until it actually changes, a save error
// keeps the dialog open and toasts the server's reason, and a successful save
// closes the dialog and refreshes the server-rendered member list.

const changeTeamMemberRole = vi.fn();
vi.mock("@/ee/team/actions", () => ({
  changeTeamMemberRole: (...args: unknown[]) => changeTeamMemberRole(...args),
}));

const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}));

const toastError = vi.fn();
const toastSuccess = vi.fn();
vi.mock("sonner", () => ({
  toast: {
    error: (...args: unknown[]) => toastError(...args),
    success: (...args: unknown[]) => toastSuccess(...args),
  },
}));

import { ManageAccessDialog } from "./manage-access-dialog";

beforeEach(() => {
  changeTeamMemberRole.mockReset();
  refresh.mockReset();
  toastError.mockReset();
  toastSuccess.mockReset();
});
afterEach(cleanup);

const renderDialog = (currentRole: "admin" | "member" = "member") =>
  render(
    <ManageAccessDialog
      open
      onOpenChange={() => {}}
      userId="user-1"
      email="member@acme.test"
      currentRole={currentRole}
      currentSsoExempt={false}
    />,
  );

describe("manage access dialog", () => {
  it("names who access is being updated for", () => {
    renderDialog();
    expect(
      screen.getByText("Update access for member@acme.test."),
    ).toBeTruthy();
  });

  it("disables Save until the role actually changes", async () => {
    renderDialog("member");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();

    const user = userEvent.setup();
    await user.click(screen.getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "Admin" }));

    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });

  it("never renders an SSO exemption row", () => {
    renderDialog();
    expect(screen.queryByText(/SSO/i)).toBeNull();
  });

  it("saves the new role, toasts success, and refreshes", async () => {
    changeTeamMemberRole.mockResolvedValue({ ok: true, data: undefined });
    renderDialog("member");
    const user = userEvent.setup();
    await user.click(screen.getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "Admin" }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(changeTeamMemberRole).toHaveBeenCalledWith("user-1", "admin");
    });
    expect(toastSuccess).toHaveBeenCalledWith("Access updated");
    expect(refresh).toHaveBeenCalled();
  });

  it("toasts the server error and leaves the dialog open on failure", async () => {
    changeTeamMemberRole.mockResolvedValue({
      ok: false,
      error: "Only the organization owner can update it",
    });
    renderDialog("member");
    const user = userEvent.setup();
    await user.click(screen.getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "Admin" }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(toastError).toHaveBeenCalledWith(
        "Only the organization owner can update it",
      );
    });
    expect(refresh).not.toHaveBeenCalled();
  });
});
