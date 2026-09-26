import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Source-as-assertion pins (the layout-injection.test.ts style) for the
// AWS Marketplace web surface's edition gates. The marketplace is a
// hosted-platform feature (only OUR seller account is behind it), so every
// web entry point must be dark on a self-host — mirroring the /v1 intake's
// cloudOnly middleware. Page/route components lean on next/navigation and
// per-request state, so the gate is pinned at the source level: removing
// or weakening any of these `IS_CLOUD` checks fails here before it ships
// a marketplace surface to self-hosts.

const read = (rel: string) => readFileSync(join(__dirname, rel), "utf8");

describe("aws-marketplace web surface is hosted-only", () => {
  it("the fulfill route 404s off cloud on BOTH methods", () => {
    const source = read("fulfill/route.ts");
    const gates = source.match(
      /if \(!IS_CLOUD\) return new NextResponse\(null, \{ status: 404 \}\);/g,
    );
    // One per exported handler (POST + GET).
    expect(gates).toHaveLength(2);
    expect(source).toContain('import { IS_CLOUD } from "@/lib/env"');
  });

  it("the register page is notFound off cloud", () => {
    const source = read("register/page.tsx");
    expect(source).toContain("if (!IS_CLOUD) notFound();");
    expect(source).toContain('import { IS_CLOUD } from "@/lib/env"');
  });

  it("both server actions are unconditionally dark (AWS Marketplace is dropped)", () => {
    // AWS Marketplace billing is permanently dropped in this onprem-only
    // fork (v2 migration plan: "billing (all) — DROP"), so these no longer
    // need a per-edition gate: they refuse on every edition, not just off
    // cloud, matching the page/route level `IS_CLOUD` gates that already
    // 404 before either action is ever reached.
    const source = readFileSync(
      join(
        __dirname,
        "..",
        "..",
        "ee",
        "billing",
        "aws-marketplace",
        "actions.ts",
      ),
      "utf8",
    );
    expect(source).toContain(
      "export const hasPendingMarketplaceToken = async (): Promise<boolean> => false;",
    );
    expect(source).toMatch(
      /completeMarketplaceRegistration =\s*async \(\): Promise<RegistrationResult> => \(\{\s*ok: false,\s*error: "Not available on this deployment\."\s*,?\s*\}\);/,
    );
  });
});
