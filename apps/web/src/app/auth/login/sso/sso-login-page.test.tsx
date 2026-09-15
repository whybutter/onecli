// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

// ── /auth/login/sso, post v2-migration Phase 0 ───────────────────────────────
//
// SSO is permanently dropped. The route now redirects unconditionally to the
// regular login rather than branching on entitlement — replaces the old
// unlicensed/licensed contract test.

vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`NEXT_REDIRECT:${to}`);
  },
}));

import Page from "./page";

describe("/auth/login/sso", () => {
  it("always redirects to the regular login", () => {
    expect(() => Page()).toThrow("NEXT_REDIRECT:/auth/login");
  });
});
