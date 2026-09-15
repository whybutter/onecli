// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── OrgDetailsForm — readOnly gating, dirty/save, error toast ──────────────

const mutate = vi.fn();
const copy = vi.fn();
const toastSuccess = vi.fn();

vi.mock("@/hooks/use-org", () => ({
  useUpdateOrg: () => ({ mutate, isPending: false }),
}));
vi.mock("@/hooks/use-copy-to-clipboard", () => ({
  useCopyToClipboard: () => ({ copied: false, copy }),
}));
vi.mock("sonner", () => ({
  toast: { success: (...args: unknown[]) => toastSuccess(...args) },
}));

import { OrgDetailsForm } from "./org-details-form";

beforeEach(() => {
  mutate.mockReset();
  copy.mockReset();
  toastSuccess.mockReset();
});
afterEach(cleanup);

describe("org details form", () => {
  it("renders read-only with no Save/Cancel for a non-owner", () => {
    render(<OrgDetailsForm orgId="org-1" orgName="Acme" readOnly />);
    expect(screen.getByDisplayValue("Acme")).toHaveAttribute("readonly");
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  });

  it("disables Save until the name is actually dirty", async () => {
    render(<OrgDetailsForm orgId="org-1" orgName="Acme" />);
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();

    const user = userEvent.setup();
    await user.clear(screen.getByDisplayValue("Acme"));
    await user.type(screen.getByLabelText("Organization name"), "Acme Inc");
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });

  it("saves the trimmed name and toasts success", async () => {
    mutate.mockImplementation((_input, opts) => opts?.onSuccess?.());
    render(<OrgDetailsForm orgId="org-1" orgName="Acme" />);
    const user = userEvent.setup();
    await user.clear(screen.getByDisplayValue("Acme"));
    await user.type(screen.getByLabelText("Organization name"), "  Acme Inc  ");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(mutate).toHaveBeenCalledWith(
        { name: "Acme Inc" },
        expect.objectContaining({ onSuccess: expect.any(Function) }),
      );
    });
    expect(toastSuccess).toHaveBeenCalledWith("Organization updated");
  });

  it("copies the organization id", async () => {
    render(<OrgDetailsForm orgId="org-1" orgName="Acme" />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Copy" }));
    expect(copy).toHaveBeenCalledWith("org-1");
  });
});
