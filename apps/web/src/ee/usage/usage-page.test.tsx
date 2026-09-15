// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import UsagePage from "./usage-page";

const state = vi.hoisted(() => ({
  data: undefined as
    | {
        periodStart: string;
        periodEnd: string;
        requests: number;
        integrationCalls: number;
        agents: {
          agentId: string;
          agentName: string | null;
          requests: number;
          integrationCalls: number;
        }[];
      }
    | undefined,
  isPending: false,
  isError: false,
}));

vi.mock("@/hooks/use-usage", () => ({
  useUsage: () => state,
}));

const reset = () => {
  state.data = undefined;
  state.isPending = false;
  state.isError = false;
};

describe("UsagePage", () => {
  it("renders the recorded-gateway-requests caveat", () => {
    reset();
    state.data = {
      periodStart: "2026-08-01T00:00:00.000Z",
      periodEnd: "2026-08-31T00:00:00.000Z",
      requests: 0,
      integrationCalls: 0,
      agents: [],
    };
    render(<UsagePage />);
    expect(
      screen.getByText(
        "Recorded gateway requests for this organization, by agent.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("recorded gateway requests")).toBeInTheDocument();
  });

  it("shows a zeroed summary rather than an error for a member with no bindings", () => {
    reset();
    state.data = {
      periodStart: "2026-08-01T00:00:00.000Z",
      periodEnd: "2026-08-31T00:00:00.000Z",
      requests: 0,
      integrationCalls: 0,
      agents: [],
    };
    render(<UsagePage />);
    expect(
      screen.getByText(
        "Run an agent through the gateway to see its usage here.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("Couldn't load usage")).not.toBeInTheDocument();
  });

  it("shows a real error distinctly from the zeroed-member state", () => {
    reset();
    state.isError = true;
    render(<UsagePage />);
    expect(screen.getByText("Couldn't load usage")).toBeInTheDocument();
  });

  it("renders the per-agent table when there is recorded usage", () => {
    reset();
    state.data = {
      periodStart: "2026-08-01T00:00:00.000Z",
      periodEnd: "2026-08-31T00:00:00.000Z",
      requests: 10,
      integrationCalls: 4,
      agents: [
        {
          agentId: "a1",
          agentName: "My Agent",
          requests: 10,
          integrationCalls: 4,
        },
      ],
    };
    render(<UsagePage />);
    expect(screen.getByText("My Agent")).toBeInTheDocument();
  });
});
