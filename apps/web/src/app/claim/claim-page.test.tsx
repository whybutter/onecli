// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

// ── /claim, post v2-migration Phase 0 ────────────────────────────────────────
//
// Provisioning/claim links are permanently dropped (invitations + Google
// login cover it instead). The wrapper is now a plain re-export of the ee
// placeholder page, which never reads a claim token — replaces the old
// unlicensed/licensed dark-reads contract test.

import Page from "./page";

describe("/claim", () => {
  it("renders the placeholder without resolving any claim token", async () => {
    render(await Page({ searchParams: Promise.resolve({ token: "tok-1" }) }));
    expect(screen.getByText("Claim link")).toBeInTheDocument();
  });
});
