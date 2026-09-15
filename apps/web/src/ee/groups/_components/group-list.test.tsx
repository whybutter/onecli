// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GroupRow } from "@/lib/api/types";

// ── GroupList — loading / empty / populated / create / rename / delete ─────
//
// No plan gate, no SCIM copy branch reachable today (source is always
// "manual"), but `source` must still be read defensively — this suite pins
// the manual-row actions (rename/delete via kebab, manage members) and
// leaves the "scim" branch to `group-members-dialog`'s own readOnly tests.

const state = vi.hoisted(() => ({
  groups: undefined as GroupRow[] | undefined,
  isPending: false,
}));

const createMutateAsync = vi.fn();
const renameMutateAsync = vi.fn();
const deleteMutate = vi.fn();

vi.mock("@/hooks/use-groups", () => ({
  useGroups: () => ({ data: state.groups, isPending: state.isPending }),
  useCreateGroup: () => ({
    mutateAsync: createMutateAsync,
    isPending: false,
  }),
  useRenameGroup: () => ({
    mutateAsync: renameMutateAsync,
    isPending: false,
  }),
  useDeleteGroup: () => ({ mutate: deleteMutate, isPending: false }),
}));

vi.mock("./group-members-dialog", () => ({
  GroupMembersDialog: ({ group }: { group: GroupRow }) => (
    <div data-testid="members-dialog">{group.name}</div>
  ),
}));

import { GroupList } from "./group-list";

const GROUP: GroupRow = {
  id: "g1",
  name: "Engineering",
  source: "manual",
  externalId: null,
  memberCount: 3,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

beforeEach(() => {
  state.groups = undefined;
  state.isPending = false;
  createMutateAsync.mockReset();
  renameMutateAsync.mockReset();
  deleteMutate.mockReset();
});
afterEach(cleanup);

describe("group list", () => {
  it("shows a loading indicator while pending", () => {
    state.isPending = true;
    render(<GroupList />);
    expect(screen.queryByText("No groups yet")).toBeNull();
  });

  it("shows the empty state with no groups", () => {
    state.groups = [];
    render(<GroupList />);
    expect(screen.getByText("No groups yet")).toBeTruthy();
    expect(
      screen.getByText(
        "Create a group to organize members for group-level access.",
      ),
    ).toBeTruthy();
  });

  it("lists groups with member counts", () => {
    state.groups = [GROUP];
    render(<GroupList />);
    expect(screen.getByText("Engineering")).toBeTruthy();
    expect(screen.getByText("3")).toBeTruthy();
  });

  it("creates a group from the New group dialog", async () => {
    state.groups = [];
    createMutateAsync.mockResolvedValue(GROUP);
    const user = userEvent.setup();
    render(<GroupList />);

    await user.click(screen.getByRole("button", { name: /New group/ }));
    await user.type(screen.getByLabelText("Name"), "Engineering");
    await user.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => {
      expect(createMutateAsync).toHaveBeenCalledWith("Engineering");
    });
  });

  it("renames a group via the kebab menu", async () => {
    state.groups = [GROUP];
    renameMutateAsync.mockResolvedValue(GROUP);
    const user = userEvent.setup();
    render(<GroupList />);

    await user.click(
      screen.getByRole("button", { name: "Actions for Engineering" }),
    );
    await user.click(await screen.findByText("Rename"));
    const input = screen.getByLabelText("Name");
    await user.clear(input);
    await user.type(input, "Platform");
    await user.click(screen.getByRole("button", { name: "Rename" }));

    await waitFor(() => {
      expect(renameMutateAsync).toHaveBeenCalledWith({
        groupId: "g1",
        name: "Platform",
      });
    });
  });

  it("deletes a group via the kebab menu with confirmation", async () => {
    state.groups = [GROUP];
    deleteMutate.mockImplementation((_id, opts) => opts?.onSuccess?.());
    const user = userEvent.setup();
    render(<GroupList />);

    await user.click(
      screen.getByRole("button", { name: "Actions for Engineering" }),
    );
    await user.click(await screen.findByText("Delete"));
    expect(screen.getByText(/Delete .Engineering.\?/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => {
      expect(deleteMutate).toHaveBeenCalledWith(
        "g1",
        expect.objectContaining({ onSuccess: expect.any(Function) }),
      );
    });
  });

  it("opens the members dialog from the row action", async () => {
    state.groups = [GROUP];
    const user = userEvent.setup();
    render(<GroupList />);

    await user.click(screen.getByRole("button", { name: "Manage members" }));
    expect(screen.getByTestId("members-dialog")).toHaveTextContent(
      "Engineering",
    );
  });
});
