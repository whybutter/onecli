import { describe, it, expect } from "vitest";
import { createDoor } from "./create-door";
import type { HostedAvailability } from "./availability";

// The self-host / fallback arm: no org world in play. BYO-first (Nanoclaw —
// a self-host-only decision): hosted is never primary here, and agent
// history plays no part at all — `CreateDoorInput` doesn't even carry it.
// The only input that matters is whether a hosted surface exists.
const open = { orgByoLegacy: null, orgByoEnabled: null };

describe("createDoor (self-host / org world unknown — BYO-first)", () => {
  it("gives a brand-new user the BYO door, with hosted a click away once a runner exists", () => {
    // BYO-first: even a user who has never made an agent, on a deployment
    // with a live runner, gets BYO as the primary button.
    expect(createDoor({ availability: "ready", ...open })).toBe(
      "byo-with-hosted",
    );
  });

  it("offers hosted as a secondary door while agents are OFFLINE — they exist, they are just down", () => {
    // Offline is a runtime state, not "the surface doesn't exist"; the dialog
    // itself explains the outage.
    expect(createDoor({ availability: "offline", ...open })).toBe(
      "byo-with-hosted",
    );
  });

  it("falls back to BYO alone where no hosted surface exists", () => {
    // Byte-identical to today's page on a deployment with no runner.
    expect(createDoor({ availability: "absent", ...open })).toBe("byo");
  });

  it("hides hosted while availability is still loading — never flash a door it might take away", () => {
    const cases: [HostedAvailability, string][] = [
      ["loading", "byo"],
      ["absent", "byo"],
      ["ready", "byo-with-hosted"],
      ["offline", "byo-with-hosted"],
    ];
    for (const [availability, expected] of cases) {
      expect(createDoor({ availability, ...open })).toBe(expected);
    }
  });
});

describe("createDoor (cloud — the org's creation world is authoritative)", () => {
  it("gives a hosted-world org the hosted door alone, in every availability state", () => {
    // §3.10 as re-decided 2026-08-23: byoLegacy=false means hosted-only
    // creation. Old BYO agents keep working; only the create door changes.
    for (const availability of [
      "ready",
      "offline",
      "absent",
      "loading",
    ] as const) {
      expect(
        createDoor({
          availability,
          orgByoLegacy: false,
          orgByoEnabled: false,
        }),
      ).toBe("hosted");
    }
  });

  it("gives a MIXED-world org the hosted-primary split door in every state", () => {
    // byoLegacy=false + byoEnabled=true (2026-08-29): hosted stays primary,
    // BYO creation is one click away. Availability doesn't gate the chevron
    // — BYO needs no runner, and the hosted-world door already ignores
    // availability on cloud.
    for (const availability of [
      "ready",
      "offline",
      "absent",
      "loading",
    ] as const) {
      expect(
        createDoor({
          availability,
          orgByoLegacy: false,
          orgByoEnabled: true,
        }),
      ).toBe("hosted-with-byo");
    }
  });

  it("never consults byoEnabled in a BYO-world org — byoLegacy wins", () => {
    for (const orgByoEnabled of [false, true, null]) {
      expect(
        createDoor({
          availability: "ready",
          orgByoLegacy: true,
          orgByoEnabled,
        }),
      ).toBe("byo-with-hosted");
    }
  });

  it("gives a BYO-world org the split door even in a fresh workspace", () => {
    expect(
      createDoor({
        availability: "ready",
        orgByoLegacy: true,
        orgByoEnabled: false,
      }),
    ).toBe("byo-with-hosted");
  });

  it("drops a BYO-world org to the plain BYO door where no hosted surface exists", () => {
    for (const availability of ["absent", "loading"] as const) {
      expect(
        createDoor({
          availability,
          orgByoLegacy: true,
          orgByoEnabled: false,
        }),
      ).toBe("byo");
    }
  });
});
