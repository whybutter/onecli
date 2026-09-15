// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OrgDomain } from "@/lib/api/types";

// ── OrgDomainsCard — loading/empty/populated, create, verify, remove ───────
//
// No plan gate, no SSO copy anywhere (dropped per the v2 migration plan).

const state = vi.hoisted(() => ({
  domains: undefined as OrgDomain[] | undefined,
  isPending: false,
  deletePending: false,
}));

const createMutate = vi.fn();
const verifyMutate = vi.fn();
const deleteMutate = vi.fn();

vi.mock("@/hooks/use-domains", () => ({
  useDomains: () => ({ data: state.domains, isPending: state.isPending }),
  useCreateDomain: () => ({ mutate: createMutate, isPending: false }),
  useVerifyDomain: () => ({
    mutate: verifyMutate,
    isPending: false,
    variables: undefined,
  }),
  useDeleteDomain: () => ({
    mutate: deleteMutate,
    isPending: state.deletePending,
  }),
}));

import { OrgDomainsCard } from "./org-domains-card";

const PENDING_DOMAIN: OrgDomain = {
  id: "d1",
  domain: "acme.test",
  verificationToken: "abc123",
  verifiedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};

const VERIFIED_DOMAIN: OrgDomain = {
  ...PENDING_DOMAIN,
  id: "d2",
  domain: "verified.test",
  verifiedAt: "2026-01-02T00:00:00.000Z",
};

beforeEach(() => {
  state.domains = undefined;
  state.isPending = false;
  state.deletePending = false;
  createMutate.mockReset();
  verifyMutate.mockReset();
  deleteMutate.mockReset();
});
afterEach(cleanup);

describe("org domains card", () => {
  it("shows a loading message while pending", () => {
    state.isPending = true;
    render(<OrgDomainsCard />);
    expect(screen.getByText("Loading domains...")).toBeTruthy();
  });

  it("shows the empty state with no domains, and never mentions SSO", () => {
    state.domains = [];
    render(<OrgDomainsCard />);
    expect(screen.getByText("No domains yet")).toBeTruthy();
    expect(screen.getByText("Claim your company domain.")).toBeTruthy();
    expect(screen.queryByText(/SSO/i)).toBeNull();
  });

  it("claims a new domain", async () => {
    state.domains = [];
    const user = userEvent.setup();
    render(<OrgDomainsCard />);
    await user.type(screen.getByPlaceholderText("example.com"), "acme.test");
    await user.click(screen.getByRole("button", { name: "Add domain" }));

    await waitFor(() => {
      expect(createMutate).toHaveBeenCalledWith(
        "acme.test",
        expect.objectContaining({ onSuccess: expect.any(Function) }),
      );
    });
  });

  it("renders the TXT record for an unverified domain", () => {
    state.domains = [PENDING_DOMAIN];
    render(<OrgDomainsCard />);
    expect(screen.getByText("Pending")).toBeTruthy();
    expect(screen.getByText("onecli-verification=abc123")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Verify" })).toBeTruthy();
  });

  it("does not render a TXT record for a verified domain", () => {
    state.domains = [VERIFIED_DOMAIN];
    render(<OrgDomainsCard />);
    expect(screen.getByText("Verified")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Verify" })).toBeNull();
    expect(screen.queryByText(/onecli-verification=/)).toBeNull();
  });

  it("calls verify for the clicked domain", async () => {
    state.domains = [PENDING_DOMAIN];
    const user = userEvent.setup();
    render(<OrgDomainsCard />);
    await user.click(screen.getByRole("button", { name: "Verify" }));
    expect(verifyMutate).toHaveBeenCalledWith("d1");
  });

  it("removes a domain after confirmation", async () => {
    state.domains = [VERIFIED_DOMAIN];
    deleteMutate.mockImplementation((_id, opts) => opts?.onSuccess?.());
    const user = userEvent.setup();
    render(<OrgDomainsCard />);
    await user.click(
      screen.getByRole("button", { name: "Remove verified.test" }),
    );
    expect(screen.getByText("Remove verified.test?")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Remove" }));

    await waitFor(() => {
      expect(deleteMutate).toHaveBeenCalledWith(
        "d2",
        expect.objectContaining({ onSuccess: expect.any(Function) }),
      );
    });
  });

  it("shows a spinner and disables both actions while removing", async () => {
    state.domains = [VERIFIED_DOMAIN];
    state.deletePending = true;
    const user = userEvent.setup();
    render(<OrgDomainsCard />);
    await user.click(
      screen.getByRole("button", { name: "Remove verified.test" }),
    );

    expect(screen.getByRole("button", { name: "Removing..." })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
  });
});
