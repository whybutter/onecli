import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthContext } from "../../providers/types";

// The guard's four outcomes (api-ee-behaviour §2.4), with the predicates
// stubbed so each arm is isolated: confinement fires before any predicate,
// a manager never has access consulted, use-without-manage is a 403, and a
// stranger is a 404.

const predicates = vi.hoisted(() => ({
  manage: vi.fn(async () => false),
  access: vi.fn(async () => false),
}));

vi.mock("./authorization-service", () => ({
  canManageWorkspace: predicates.manage,
  canAccessWorkspace: predicates.access,
}));

import { requireWorkspaceManagement } from "./workspace-management-guard";

const ctx = (
  scope: AuthContext["scope"],
  workspaceId?: string,
): AuthContext => ({
  userId: "user-1",
  userEmail: "user@example.com",
  organizationId: "org-1",
  workspaceId,
  scope,
});

beforeEach(() => {
  predicates.manage.mockReset().mockResolvedValue(false);
  predicates.access.mockReset().mockResolvedValue(false);
});

describe("requireWorkspaceManagement", () => {
  it("confines a workspace key to its own workspace before any predicate runs", async () => {
    await expect(
      requireWorkspaceManagement(ctx("workspace", "ws-a"), "ws-b"),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Workspace not found",
    });
    expect(predicates.manage).not.toHaveBeenCalled();
    expect(predicates.access).not.toHaveBeenCalled();
  });

  it("lets a workspace key manage its own workspace", async () => {
    predicates.manage.mockResolvedValue(true);
    await expect(
      requireWorkspaceManagement(ctx("workspace", "ws-a"), "ws-a"),
    ).resolves.toBeUndefined();
  });

  it("never confines an org key or a session", async () => {
    predicates.manage.mockResolvedValue(true);
    await expect(
      requireWorkspaceManagement(ctx("organization", "ws-a"), "ws-b"),
    ).resolves.toBeUndefined();
    await expect(
      requireWorkspaceManagement(ctx("session", "ws-a"), "ws-b"),
    ).resolves.toBeUndefined();
  });

  it("a manager passes without access being consulted", async () => {
    predicates.manage.mockResolvedValue(true);
    await expect(
      requireWorkspaceManagement(ctx("session"), "ws-a"),
    ).resolves.toBeUndefined();
    expect(predicates.access).not.toHaveBeenCalled();
  });

  it("use without manage is a 403", async () => {
    predicates.access.mockResolvedValue(true);
    await expect(
      requireWorkspaceManagement(ctx("session"), "ws-a"),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "You don't have permission to manage this workspace",
    });
  });

  it("a stranger is a 404 — existence never leaks", async () => {
    await expect(
      requireWorkspaceManagement(ctx("session"), "ws-a"),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Workspace not found",
    });
  });
});
