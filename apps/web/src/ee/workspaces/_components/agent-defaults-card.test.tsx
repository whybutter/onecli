// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AgentDefaultsCard } from "./agent-defaults-card";

const state = vi.hoisted(() => ({
  connections: [
    { id: "c1", provider: "github", label: "GitHub", scope: "workspace" },
    { id: "c2", provider: "slack", label: null, scope: "organization" },
  ],
  defaults: [] as { connectionId: string }[],
}));

const setMock = vi.hoisted(() => vi.fn());
const removeMock = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/use-connections", () => ({
  useConnections: () => ({ data: state.connections, isPending: false }),
}));

vi.mock("@/hooks/use-agent-defaults", () => ({
  useAgentDefaults: () => ({ data: state.defaults, isPending: false }),
  useSetAgentDefault: () => ({ mutate: setMock, isPending: false }),
  useRemoveAgentDefault: () => ({ mutate: removeMock, isPending: false }),
}));

const renderCard = (canManage = true) => {
  const qc = new QueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <AgentDefaultsCard workspaceId="w1" canManage={canManage} />
    </QueryClientProvider>,
  );
};

describe("AgentDefaultsCard", () => {
  beforeEach(() => {
    state.defaults = [];
    setMock.mockClear();
    removeMock.mockClear();
  });

  it("lists every connection in the workspace's pool, off by default", () => {
    renderCard();
    expect(screen.getByText("GitHub")).toBeInTheDocument();
    expect(screen.getByText("slack")).toBeInTheDocument();
    const switches = screen.getAllByRole("switch");
    expect(switches).toHaveLength(2);
    expect(switches[0]).not.toBeChecked();
  });

  it("turning a toggle on sets a full-access default", async () => {
    renderCard();
    const user = userEvent.setup();
    const [firstSwitch] = screen.getAllByRole("switch");
    await user.click(firstSwitch!);
    expect(setMock).toHaveBeenCalledWith({
      connectionId: "c1",
      input: { access: "full", resources: null },
    });
  });

  it("turning an existing default off removes it", async () => {
    state.defaults = [{ connectionId: "c1" }];
    renderCard();
    const user = userEvent.setup();
    const [firstSwitch] = screen.getAllByRole("switch");
    await waitFor(() => expect(firstSwitch!).toBeChecked());
    await user.click(firstSwitch!);
    expect(removeMock).toHaveBeenCalledWith("c1");
  });

  it("disables every toggle when the caller cannot manage the workspace", () => {
    renderCard(false);
    for (const el of screen.getAllByRole("switch")) {
      expect(el).toBeDisabled();
    }
  });
});
