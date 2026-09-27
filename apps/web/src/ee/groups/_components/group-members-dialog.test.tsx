// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GroupRow } from "@/lib/api/types";

// ── GroupMembersDialog — seed-once, dirty gating, readOnly for scim rows ───

const state = vi.hoisted(() => ({
  orgMembers: undefined as
    | { userId: string; email: string; name: string | null }[]
    | undefined,
  orgMembersPending: false,
  groupMembers: undefined as { userId: string }[] | undefined,
  groupMembersPending: false,
}));

const setMembersMutate = vi.fn();
vi.mock("@/hooks/use-org-members", () => ({
  useOrgMembersList: () => ({
    data: state.orgMembers,
    isPending: state.orgMembersPending,
  }),
}));
vi.mock("@/hooks/use-groups", () => ({
  useGroupMembers: () => ({
    data: state.groupMembers,
    isPending: state.groupMembersPending,
  }),
  useSetGroupMembers: () => ({
    mutate: setMembersMutate,
    isPending: false,
  }),
}));

import { GroupMembersDialog } from "./group-members-dialog";

const MANUAL_GROUP: GroupRow = {
  id: "g1",
  name: "Engineering",
  source: "manual",
  externalId: null,
  memberCount: 2,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const SCIM_GROUP: GroupRow = { ...MANUAL_GROUP, id: "g2", source: "scim" };

const MEMBERS = [
  { userId: "u1", email: "ada@acme.test", name: "Ada Lovelace" },
  { userId: "u2", email: "grace@acme.test", name: "Grace Hopper" },
];

beforeEach(() => {
  state.orgMembers = MEMBERS;
  state.orgMembersPending = false;
  state.groupMembers = [{ userId: "u1" }];
  state.groupMembersPending = false;
  setMembersMutate.mockReset();
});
afterEach(cleanup);

describe("group members dialog", () => {
  it("shows a loading state while either query is pending", () => {
    state.groupMembersPending = true;
    render(
      <GroupMembersDialog group={MANUAL_GROUP} open onOpenChange={() => {}} />,
    );
    expect(screen.queryByText("Ada Lovelace")).toBeNull();
  });

  it("shows no-org-members empty state", () => {
    state.orgMembers = [];
    render(
      <GroupMembersDialog group={MANUAL_GROUP} open onOpenChange={() => {}} />,
    );
    expect(screen.getByText("No members found")).toBeTruthy();
  });

  it("seeds selection from the group's current members", () => {
    render(
      <GroupMembersDialog group={MANUAL_GROUP} open onOpenChange={() => {}} />,
    );
    const checkboxes = screen.getAllByRole("checkbox");
    expect(checkboxes[0]).toBeChecked(); // u1 (Ada) is a current member
    expect(checkboxes[1]).not.toBeChecked(); // u2 (Grace) is not
  });

  it("disables Save until the selection actually changes", async () => {
    render(
      <GroupMembersDialog group={MANUAL_GROUP} open onOpenChange={() => {}} />,
    );
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();

    const user = userEvent.setup();
    await user.click(screen.getAllByRole("checkbox")[1]!);
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });

  it("filters members by name or email", async () => {
    render(
      <GroupMembersDialog group={MANUAL_GROUP} open onOpenChange={() => {}} />,
    );
    const user = userEvent.setup();
    await user.type(
      screen.getByLabelText("Filter members by name or email"),
      "grace",
    );
    expect(screen.queryByText("Ada Lovelace")).toBeNull();
    expect(screen.getByText("Grace Hopper")).toBeTruthy();
  });

  it("saves the replace-set of selected userIds", async () => {
    setMembersMutate.mockImplementation((_input, opts) => opts?.onSuccess?.());
    render(
      <GroupMembersDialog group={MANUAL_GROUP} open onOpenChange={() => {}} />,
    );
    const user = userEvent.setup();
    await user.click(screen.getAllByRole("checkbox")[1]!);
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(setMembersMutate).toHaveBeenCalledWith(
        { groupId: "g1", userIds: expect.arrayContaining(["u1", "u2"]) },
        expect.objectContaining({ onSuccess: expect.any(Function) }),
      );
    });
  });

  it("is read-only for a scim-sourced group", () => {
    render(
      <GroupMembersDialog group={SCIM_GROUP} open onOpenChange={() => {}} />,
    );
    expect(
      screen.getByText(
        "This group is managed by your identity provider. Membership syncs from the IdP.",
      ),
    ).toBeTruthy();
    for (const checkbox of screen.getAllByRole("checkbox")) {
      expect(checkbox).toBeDisabled();
    }
    // Two "Close" buttons legitimately co-exist: the dialog's own X (icon,
    // sr-only label) and the read-only footer's visible "Close" button.
    expect(screen.getAllByRole("button", { name: "Close" })).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  });
});
