// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ENTERPRISE_FEATURES } from "@onecli/api/lib/entitlements";
import { PlanGateProvider, usePlanGate } from "./plan-gate";

// ── THE client feature gate, post v2-migration Phase 0 ──────────────────────
//
// This build has no billing (`usePlanUsage` never fetches) and no license
// dial (`isEntitled()` is always true), so `plan-gate` is a constant no-op:
// nothing is ever locked, and `guard()` never opens a dialog. This replaces
// the old fork's plan-lock/license-lock contract test now that both locks
// are permanently disarmed.

const FEATURES = Object.keys(ENTERPRISE_FEATURES);

const Probe = () => {
  const gate = usePlanGate();
  return (
    <div>
      {FEATURES.map((f) => (
        <span key={f} data-testid={`lock-${f}`}>
          {String(gate.isLocked(f))}
        </span>
      ))}
      <span data-testid="lock-nonfeature">
        {String(gate.isLocked("agents"))}
      </span>
      <span data-testid="guard-result">{String(gate.guard("groups"))}</span>
    </div>
  );
};

describe("plan-gate (always disarmed)", () => {
  it("locks nothing — no billing, no license dial", () => {
    render(
      <PlanGateProvider>
        <Probe />
      </PlanGateProvider>,
    );
    for (const f of FEATURES) {
      expect(screen.getByTestId(`lock-${f}`).textContent, f).toBe("false");
    }
    expect(screen.getByTestId("lock-nonfeature").textContent).toBe("false");
  });

  it("guard() never intercepts — always returns false", () => {
    render(
      <PlanGateProvider>
        <Probe />
      </PlanGateProvider>,
    );
    expect(screen.getByTestId("guard-result").textContent).toBe("false");
  });
});
