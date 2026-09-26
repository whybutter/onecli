// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiKeyCard } from "./api-key-card";

const state = vi.hoisted(() => ({
  apiKey: "oc_1234567890abcdefghijklmnop",
  lastUsedAt: null as string | null,
}));

const regenerateMock = vi.hoisted(() =>
  vi.fn(async () => ({ apiKey: "oc_regeneratedabcdefghijklmnop" })),
);

vi.mock("@/lib/actions/api-key", () => ({
  getApiKey: async () => ({
    apiKey: state.apiKey,
    lastUsedAt: state.lastUsedAt,
  }),
  regenerateApiKey: regenerateMock,
}));

describe("ApiKeyCard", () => {
  beforeEach(() => {
    state.apiKey = "oc_1234567890abcdefghijklmnop";
    state.lastUsedAt = null;
    regenerateMock.mockClear();
  });

  it("masks the key by default", async () => {
    render(<ApiKeyCard />);
    const code = await screen.findByText((_, el) => el?.tagName === "CODE");
    expect(code.textContent).not.toContain(state.apiKey);
    expect(code.textContent).toContain("••••••••••••");
  });

  it("reveals the raw key on click, and hides it again", async () => {
    render(<ApiKeyCard />);
    await screen.findByText((_, el) => el?.tagName === "CODE");
    const user = userEvent.setup();
    const [reveal] = screen.getAllByRole("button");
    await user.click(reveal!);
    const code = screen.getByText((_, el) => el?.tagName === "CODE");
    expect(code.textContent).toBe(state.apiKey);
    await user.click(reveal!);
    expect(
      screen.getByText((_, el) => el?.tagName === "CODE").textContent,
    ).not.toContain(state.apiKey);
  });

  it('shows "Never used" when the key has no lastUsedAt', async () => {
    state.lastUsedAt = null;
    render(<ApiKeyCard />);
    expect(await screen.findByText("Never used")).toBeInTheDocument();
  });

  it('shows "Last used …" with a relative time when lastUsedAt is set', async () => {
    state.lastUsedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    render(<ApiKeyCard />);
    expect(await screen.findByText(/^Last used /)).toBeInTheDocument();
  });

  it("resets to Never used after a regenerate", async () => {
    state.lastUsedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    render(<ApiKeyCard />);
    await screen.findByText(/^Last used /);
    const user = userEvent.setup();
    // Open the regenerate confirm dialog (the third icon button) and confirm.
    const buttons = screen.getAllByRole("button");
    await user.click(buttons[2]!);
    await user.click(await screen.findByRole("button", { name: "Regenerate" }));
    await waitFor(() => {
      expect(screen.getByText("Never used")).toBeInTheDocument();
    });
    expect(regenerateMock).toHaveBeenCalled();
  });
});
