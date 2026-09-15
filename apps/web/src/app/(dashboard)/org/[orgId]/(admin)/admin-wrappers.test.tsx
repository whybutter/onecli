// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// ── The admin route wrappers, post v2-migration Phase 0 ─────────────────────
//
// `isEntitled()` is now always true, so each locked-page wrapper's old
// `isEntitled() ? <EePage/> : <EnterpriseLockedCard/>` branch collapsed to a
// plain re-export of its ee page. Permanently dropped surfaces (SSO
// settings) redirect instead of rendering a placeholder — see
// `settings/sso/page.tsx`. There is no more "Enterprise" text anywhere.
//
// Phase 3 built out Groups and Domains for real (WP-A): those two wrappers
// are asserted against their ACTUAL page content below, not a mock standing
// in for it — the whole point of this rewrite (phase3-plan.md's WP-A free-
// file edit) is to prove the wrapper delegates to real content, not a
// `ComingSoonCard` placeholder that would otherwise look identical to a
// mocked `data-testid` div. App availability stays deferred (v2 migration
// Decision 3) and is still exercised through the old mock-based contract.

vi.mock("@/lib/auth/require-org-admin", () => ({
  requireOrgAdmin: async () => ({
    userId: "user-1",
    userEmail: "owner@acme.test",
    organizationId: "org-1",
  }),
}));
vi.mock("@/ee/groups/_components/group-list", () => ({
  GroupList: () => <div data-testid="real-group-list" />,
}));
vi.mock("@/ee/settings/_components/org-domains-card", () => ({
  OrgDomainsCard: () => <div data-testid="real-domains-card" />,
}));

vi.mock("@/ee/app-availability/app-availability-page", () => ({
  default: () => <div data-testid="inner-app-availability" />,
}));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`NEXT_REDIRECT:${to}`);
  },
}));

import GroupsWrapper from "./groups/page";
import SsoWrapper from "./settings/sso/page";
import DomainsWrapper from "./settings/domains/page";
import AppAvailabilityWrapper from "./settings/app-availability/page";

describe("groups wrapper", () => {
  it("renders the real Groups page content, not a placeholder", async () => {
    render(await GroupsWrapper());
    expect(screen.getByRole("heading", { name: "Groups" })).toBeTruthy();
    expect(screen.getByTestId("real-group-list")).toBeTruthy();
    expect(screen.queryByText("Enterprise")).toBeNull();
    expect(screen.queryByText(/later phase/i)).toBeNull();
  });
});

describe("domains wrapper", () => {
  it("renders the real Domains page content, not a placeholder", async () => {
    render(await DomainsWrapper());
    expect(screen.getByRole("heading", { name: "Domains" })).toBeTruthy();
    expect(screen.getByTestId("real-domains-card")).toBeTruthy();
    expect(screen.queryByText("Enterprise")).toBeNull();
    expect(screen.queryByText(/later phase/i)).toBeNull();
  });
});

describe("app-availability wrapper", () => {
  it("still renders the deferred placeholder — no more locked state", () => {
    render(<AppAvailabilityWrapper />);
    expect(screen.getByTestId("inner-app-availability")).toBeInTheDocument();
    expect(screen.queryByText("Enterprise")).toBeNull();
  });
});

describe("sso wrapper", () => {
  it("SSO is permanently dropped: redirects to org settings instead of a placeholder", async () => {
    await expect(
      SsoWrapper({ params: Promise.resolve({ orgId: "org-1" }) }),
    ).rejects.toThrow("NEXT_REDIRECT:/org/org-1/settings/general");
  });
});
