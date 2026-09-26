import { describe, expect, it, vi } from "vitest";

// ── /claim, post v2-migration Phase 0 ────────────────────────────────────────
//
// Provisioning/claim links are permanently dropped (invitations + Google
// login cover it instead). The route now redirects home unconditionally
// rather than rendering a placeholder — replaces the old
// unlicensed/licensed dark-reads contract test.

vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`NEXT_REDIRECT:${to}`);
  },
}));

import Page from "./page";

describe("/claim", () => {
  it("always redirects home", () => {
    expect(() => Page()).toThrow("NEXT_REDIRECT:/");
  });
});
