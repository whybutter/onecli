import { describe, expect, it } from "vitest";

import {
  ENTERPRISE_FEATURES,
  initEntitlementForTests,
  isEnterpriseFeature,
  isEntitled,
} from "./entitlements";
import { assertEntitled, enterpriseLicenseMessage } from "./entitlements-guard";

// This build is always entitled (v2 migration, principle 3): there is no
// licence flag and no unentitled state. The registry and the refusal-message
// helper survive because the web's plan gate still keys on them.

describe("isEntitled", () => {
  it("is unconditionally true", () => {
    expect(isEntitled()).toBe(true);
  });

  it("ignores the legacy test override in both directions", () => {
    initEntitlementForTests(false);
    expect(isEntitled()).toBe(true);
    initEntitlementForTests(null);
    expect(isEntitled()).toBe(true);
  });
});

describe("isEnterpriseFeature", () => {
  it("narrows registry keys and rejects everything else", () => {
    for (const key of Object.keys(ENTERPRISE_FEATURES)) {
      expect(isEnterpriseFeature(key)).toBe(true);
    }
    // Plan-only features must NOT be enterprise keys — deny-mode, approvals
    // and rate limits stay free on self-host by decision (#44/45/46).
    expect(isEnterpriseFeature("policy.deny_mode")).toBe(false);
    expect(isEnterpriseFeature("policy.manual_approval")).toBe(false);
    expect(isEnterpriseFeature("policy.rate_limit")).toBe(false);
  });
});

describe("assertEntitled", () => {
  it("never throws", () => {
    for (const key of Object.keys(ENTERPRISE_FEATURES)) {
      expect(() =>
        assertEntitled(key as keyof typeof ENTERPRISE_FEATURES),
      ).not.toThrow();
    }
  });

  it("still formats the historical refusal message", () => {
    expect(enterpriseLicenseMessage("groups")).toBe(
      "Directory groups requires a OneCLI Enterprise license.",
    );
  });
});
