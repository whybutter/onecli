// @vitest-environment jsdom
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { queryKeys } from "@/lib/api/keys";

// ── useActiveOrg — query-backed, invalidatable from elsewhere ──────────────
//
// The old implementation fetched in a mount effect keyed only on the URL org
// id, so a rename (which doesn't change the URL) never reached the switcher
// without a full reload. This pins that it is now a real query under
// `queryKeys.org.list()` — reachable by `useUpdateOrg`'s invalidation — and
// that the optimistic `setActiveOrgId` override still works and clears once
// the URL catches up (the switcher's instant-highlight behavior).

const state = vi.hoisted(() => ({ pathname: "/org/o1/workspaces" }));
vi.mock("next/navigation", () => ({
  usePathname: () => state.pathname,
}));

// `queryKeys.org.list()` scopes on `window.location.pathname` directly (the
// same mechanism `queryKeys.org.all()` already uses) — NOT on the mocked
// `usePathname()` above. A real `router.push` keeps both in sync via the
// History API; this helper does the same so the query key actually changes
// on "navigation," matching production instead of only the hook's own
// `orgId` memo.
const navigateTo = (pathname: string) => {
  state.pathname = pathname;
  window.history.pushState({}, "", pathname);
};

const getUserOrganizations = vi.fn();
const getActiveOrganizationId = vi.fn();
vi.mock("@/lib/workspaces/actions", () => ({
  getUserOrganizations: (...args: unknown[]) => getUserOrganizations(...args),
  getActiveOrganizationId: (...args: unknown[]) =>
    getActiveOrganizationId(...args),
}));

const { useActiveOrg } = await import("./use-active-org");

const ORGS = [
  { id: "o1", name: "First org", slug: "first", role: "owner" },
  { id: "o2", name: "Second org", slug: "second", role: "member" },
];

const setup = () => {
  const qc = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return { qc, wrapper };
};

beforeEach(() => {
  navigateTo("/org/o1/workspaces");
  getUserOrganizations.mockResolvedValue(ORGS);
  getActiveOrganizationId.mockResolvedValue("o1");
});
afterEach(cleanup);

describe("useActiveOrg", () => {
  it("resolves orgs and the active org from the query", async () => {
    const { wrapper } = setup();
    const { result } = renderHook(() => useActiveOrg(), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.orgs).toEqual(ORGS);
    expect(result.current.activeOrgId).toBe("o1");
    expect(result.current.activeOrg?.name).toBe("First org");
  });

  it("is reachable by an outside invalidation of queryKeys.org.list()", async () => {
    const { wrapper, qc } = setup();
    const { result } = renderHook(() => useActiveOrg(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    getUserOrganizations.mockResolvedValue([
      { ...ORGS[0], name: "Renamed org" },
      ORGS[1],
    ]);
    await qc.invalidateQueries({ queryKey: queryKeys.org.list() });

    await waitFor(() =>
      expect(result.current.activeOrg?.name).toBe("Renamed org"),
    );
  });

  it("highlights the switcher's optimistic override until the URL catches up", async () => {
    const { wrapper } = setup();
    const { result, rerender } = renderHook(() => useActiveOrg(), {
      wrapper,
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    result.current.setActiveOrgId("o2");
    rerender();
    expect(result.current.activeOrgId).toBe("o2");

    // Navigation completes — the URL now matches the override, which clears
    // (and the query key changes too, refetching the new org's own facts).
    getActiveOrganizationId.mockResolvedValue("o2");
    navigateTo("/org/o2/workspaces");
    rerender();
    await waitFor(() => expect(result.current.activeOrgId).toBe("o2"));
  });
});
