// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// ── The admin route wrappers, post v2-migration Phase 0 ─────────────────────
//
// `isEntitled()` is now always true, so each locked-page wrapper's old
// `isEntitled() ? <EePage/> : <EnterpriseLockedCard/>` branch collapsed to a
// plain re-export of its (placeholder) ee page. Permanently dropped surfaces
// (SSO settings) redirect instead of rendering a placeholder — see
// `settings/sso/page.tsx`. This replaces the old unlicensed/licensed
// contract test: there is no more "Enterprise" text anywhere in the UI.

vi.mock("@/ee/groups/groups-page", () => ({
  default: () => <div data-testid="inner-groups" />,
}));
vi.mock("@/ee/settings/org-domains-page", () => ({
  default: () => <div data-testid="inner-domains" />,
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

const WRAPPERS = [
  { name: "groups", Page: GroupsWrapper, inner: "inner-groups" },
  { name: "domains", Page: DomainsWrapper, inner: "inner-domains" },
  {
    name: "app-availability",
    Page: AppAvailabilityWrapper,
    inner: "inner-app-availability",
  },
] as const;

describe.each(WRAPPERS.map((w) => [w.name, w] as const))(
  "%s wrapper",
  (_name, wrapper) => {
    it("always renders the inner (placeholder) page — no more locked state", () => {
      render(<wrapper.Page />);
      expect(screen.getByTestId(wrapper.inner)).toBeInTheDocument();
      expect(screen.queryByText("Enterprise")).toBeNull();
    });
  },
);

describe("sso wrapper", () => {
  it("SSO is permanently dropped: redirects to org settings instead of a placeholder", async () => {
    await expect(
      SsoWrapper({ params: Promise.resolve({ orgId: "org-1" }) }),
    ).rejects.toThrow("NEXT_REDIRECT:/org/org-1/settings/general");
  });
});
