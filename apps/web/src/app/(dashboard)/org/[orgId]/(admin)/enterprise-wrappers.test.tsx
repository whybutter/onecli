// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// ── The four admin route wrappers, post v2-migration Phase 0 ────────────────
//
// `isEntitled()` is now always true, so each wrapper's old
// `isEntitled() ? <EePage/> : <EnterpriseLockedCard/>` branch collapsed to a
// plain re-export of its (placeholder) ee page. This replaces the old
// unlicensed/licensed contract test: there is no more "Enterprise" text
// anywhere in the UI, and every wrapper renders its inner page
// unconditionally.

vi.mock("@/ee/groups/groups-page", () => ({
  default: () => <div data-testid="inner-groups" />,
}));
vi.mock("@/ee/settings/org-sso-page", () => ({
  default: () => <div data-testid="inner-sso" />,
}));
vi.mock("@/ee/settings/org-domains-page", () => ({
  default: () => <div data-testid="inner-domains" />,
}));
vi.mock("@/ee/app-availability/app-availability-page", () => ({
  default: () => <div data-testid="inner-app-availability" />,
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
  it("SSO settings is permanently dropped: the placeholder ee page renders unconditionally", () => {
    render(<SsoWrapper />);
    expect(screen.getByTestId("inner-sso")).toBeInTheDocument();
    expect(screen.queryByText("Enterprise")).toBeNull();
  });
});
