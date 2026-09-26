// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The create-org card: pre-filled name, submit disabled while blank, the
 * action's `redirectTo` drives navigation, and a failure lands as a toast
 * instead of a dead button.
 */

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  createOrganizationAction: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push }),
}));
vi.mock("@/ee/settings/actions", () => ({
  createOrganizationAction: mocks.createOrganizationAction,
}));
vi.mock("sonner", () => ({
  toast: { error: mocks.toastError, success: vi.fn() },
}));

const { CreateOrgForm } = await import("./create-org-form");

describe("CreateOrgForm", () => {
  beforeEach(() => {
    mocks.push.mockReset();
    mocks.createOrganizationAction.mockReset();
    mocks.toastError.mockReset();
  });

  it("renders the heading, the pre-filled name and the helper copy", () => {
    render(<CreateOrgForm defaultName="Ada's Org" />);
    expect(
      screen.getByRole("heading", {
        level: 1,
        name: "Create a new organization",
      }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toHaveValue("Ada's Org");
    expect(screen.getByLabelText("Name")).toHaveAttribute(
      "placeholder",
      "My Organization",
    );
    expect(
      screen.getByText(/What is the name of your company or team\?/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/billing/i)).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Create organization" }),
    ).toBeEnabled();
  });

  it("disables submit while the name is blank", async () => {
    const user = userEvent.setup();
    render(<CreateOrgForm defaultName="Ada's Org" />);
    await user.clear(screen.getByLabelText("Name"));
    expect(
      screen.getByRole("button", { name: "Create organization" }),
    ).toBeDisabled();
    await user.type(screen.getByLabelText("Name"), "   ");
    expect(
      screen.getByRole("button", { name: "Create organization" }),
    ).toBeDisabled();
  });

  it("creates with the trimmed name and follows redirectTo", async () => {
    const user = userEvent.setup();
    mocks.createOrganizationAction.mockResolvedValue({
      ok: true,
      data: { redirectTo: "/org/org-2/workspaces" },
    });
    render(<CreateOrgForm defaultName="" />);
    await user.type(screen.getByLabelText("Name"), "  Acme  ");
    await user.click(
      screen.getByRole("button", { name: "Create organization" }),
    );
    await waitFor(() =>
      expect(mocks.push).toHaveBeenCalledWith("/org/org-2/workspaces"),
    );
    expect(mocks.createOrganizationAction).toHaveBeenCalledWith("Acme");
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("toasts the action's error and stays put", async () => {
    const user = userEvent.setup();
    mocks.createOrganizationAction.mockResolvedValue({
      ok: false,
      error: 'You already have an organization named "Acme".',
    });
    render(<CreateOrgForm defaultName="Acme" />);
    await user.click(
      screen.getByRole("button", { name: "Create organization" }),
    );
    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith(
        'You already have an organization named "Acme".',
      ),
    );
    expect(mocks.push).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Create organization" }),
    ).toBeEnabled();
  });
});
