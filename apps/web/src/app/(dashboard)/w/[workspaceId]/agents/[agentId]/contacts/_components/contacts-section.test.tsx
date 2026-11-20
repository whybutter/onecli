// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { ActAsYouSlot } from "./act-as-you-slot";
import { ContactsSection } from "./contacts-section";

vi.mock("./contacts-list", () => ({
  ContactsList: ({ actAsYou }: { actAsYou?: ActAsYouSlot }) => (
    <div data-testid="list">
      {actAsYou ? "personal Slack" : "agent contacts"}
    </div>
  ),
}));

it("renders agent contacts without offering personal Slack grants", () => {
  render(<ContactsSection />);
  expect(screen.getByTestId("list")).toHaveTextContent("agent contacts");
});
