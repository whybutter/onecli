// @vitest-environment jsdom
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { queryKeys } from "@/lib/api/keys";

// ── useUpdateOrg — reaches the org switcher's own query on rename ──────────
//
// The switcher/account-menu read the org via `queryKeys.org.list()` (server
// actions in `lib/dashboard/use-active-org.ts`), a SEPARATE query from this
// hook's own `queryKeys.org.all()` (`GET /v1/org`) — a `setQueryData` on
// `all()` alone can't reach it. This pins that the rename mutation also
// invalidates `list()`, so the switcher picks up a rename without a reload.

vi.mock("@/lib/api", () => ({
  org: {
    update: vi.fn().mockResolvedValue({ id: "org-1", name: "Acme Inc" }),
  },
}));
vi.mock("sonner", () => ({
  toast: { error: vi.fn() },
}));

const { useUpdateOrg } = await import("./use-org");

const setup = () => {
  const qc = new QueryClient();
  const spy = vi.spyOn(qc, "invalidateQueries");
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  const sweptKeys = () => spy.mock.calls.map((call) => call[0]?.queryKey);
  return { wrapper, sweptKeys };
};

describe("useUpdateOrg", () => {
  it("invalidates the active-org (switcher) query on success", async () => {
    const { wrapper, sweptKeys } = setup();
    const { result } = renderHook(() => useUpdateOrg(), { wrapper });
    await result.current.mutateAsync({ name: "Acme Inc" });
    expect(sweptKeys()).toContainEqual(queryKeys.org.list());
  });
});
