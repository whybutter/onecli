import { describe, expect, it, vi } from "vitest";

// ── requireOrgAdmin, the org-admin guard's fail-closed contract ─────────────
//
// Two distinct failure modes, two distinct redirects: no org context at all
// (not authenticated, no membership) must never leak an org id into the
// redirect target, so it goes home; a known org whose role check refuses
// goes to that org's own workspace list. Neither failure should reach the
// error boundary.

const state = vi.hoisted(() => ({
  resolveOrgContext: vi.fn(),
  requireRole: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`NEXT_REDIRECT:${to}`);
  },
}));
vi.mock("@/lib/actions/resolve-user", () => ({
  resolveOrgContext: state.resolveOrgContext,
}));
vi.mock("@onecli/api/ee/services/authorization-service", () => ({
  requireRole: state.requireRole,
}));

import { requireOrgAdmin } from "./require-org-admin";

describe("requireOrgAdmin", () => {
  it("no org context can be resolved: redirects home (never surfaces the resolver's error)", async () => {
    state.resolveOrgContext.mockRejectedValueOnce(
      new Error("X-Organization-Id header is required"),
    );
    await expect(requireOrgAdmin()).rejects.toThrow("NEXT_REDIRECT:/");
    expect(state.requireRole).not.toHaveBeenCalled();
  });

  it("org is known but the role check refuses: redirects to that org's workspaces", async () => {
    state.resolveOrgContext.mockResolvedValueOnce({
      userId: "u1",
      userEmail: "u1@example.test",
      organizationId: "org-1",
    });
    state.requireRole.mockRejectedValueOnce(
      new Error("Insufficient permissions"),
    );
    await expect(requireOrgAdmin()).rejects.toThrow(
      "NEXT_REDIRECT:/org/org-1/workspaces",
    );
  });

  it("admin/owner: returns the org context without redirecting", async () => {
    const ctx = {
      userId: "u1",
      userEmail: "u1@example.test",
      organizationId: "org-1",
    };
    state.resolveOrgContext.mockResolvedValueOnce(ctx);
    state.requireRole.mockResolvedValueOnce("admin");
    await expect(requireOrgAdmin()).resolves.toEqual(ctx);
  });
});
