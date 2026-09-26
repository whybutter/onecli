// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { InstallContent } from "./install-content";

vi.mock("next/navigation", () => ({
  usePathname: () => "/w/w1/settings/install",
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/hooks/use-agents", () => ({
  useAgents: () => ({ data: [] }),
  useAgentDetail: () => ({ data: undefined, isError: false }),
}));

const installInfo = vi.hoisted(() => ({
  data: {
    apiKey: "oc_1234567890abcdefghijklmnop",
    apiUrl: "http://localhost:10256",
    appUrl: "http://localhost:10254",
    lastUsedAt: null as string | null,
  },
}));

vi.mock("@/hooks/use-install-info", () => ({
  useInstallInfo: () => installInfo,
}));

vi.mock("./agent-context-select", () => ({
  AgentContextSelect: () => null,
}));
vi.mock("./setup-status-card", () => ({ SetupStatusCard: () => null }));
vi.mock("./tool-pills", () => ({ ToolPills: () => null }));

describe("InstallContent — manual command masking", () => {
  it("masks the API key in the manual install command by default", () => {
    render(<InstallContent />);
    const pre = screen.getByText(
      (_, el) =>
        el?.tagName === "PRE" &&
        (el.textContent ?? "").includes("onecli auth login"),
    );
    expect(pre.textContent).not.toContain(installInfo.data.apiKey);
    expect(pre.textContent).toContain("••••••••••••");
  });

  it("reveals the real key only after the explicit reveal action", async () => {
    render(<InstallContent />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Reveal API key" }));
    const pre = screen.getByText(
      (_, el) =>
        el?.tagName === "PRE" &&
        (el.textContent ?? "").includes("onecli auth login"),
    );
    expect(pre.textContent).toContain(installInfo.data.apiKey);
    expect(
      screen.getByRole("button", { name: "Hide API key" }),
    ).toBeInTheDocument();
  });
});
