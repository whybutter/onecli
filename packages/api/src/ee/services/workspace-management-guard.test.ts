import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthContext } from "../../providers/types";

// The guard's outcomes (api-ee-behaviour §2.4), with the predicates stubbed
// so each arm is isolated: confinement fires before any predicate, the
// caller's-org fence fires next (before manage/access are ever consulted), a
// manager never has access consulted, use-without-manage is a 403, and a
// stranger is a 404.

const predicates = vi.hoisted(() => ({
  manage: vi.fn(async () => false),
  access: vi.fn(async () => false),
}));

vi.mock("./authorization-service", () => ({
  canManageWorkspace: predicates.manage,
  canAccessWorkspace: predicates.access,
}));

const store = vi.hoisted(() => ({
  // workspaceId -> organizationId. Every test's workspaces default into
  // "org-1", matching `ctx()`'s default — the cross-org tests override this.
  workspaces: { "ws-a": "org-1", "ws-b": "org-1" } as Record<string, string>,
}));

vi.mock("@onecli/db", () => ({
  Prisma: {},
  db: {
    workspace: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        const organizationId = store.workspaces[where.id];
        return organizationId === undefined ? null : { organizationId };
      },
    },
  },
}));

import { requireWorkspaceManagement } from "./workspace-management-guard";

const ctx = (
  scope: AuthContext["scope"],
  workspaceId?: string,
  organizationId = "org-1",
): AuthContext => ({
  userId: "user-1",
  userEmail: "user@example.com",
  organizationId,
  workspaceId,
  scope,
});

beforeEach(() => {
  predicates.manage.mockReset().mockResolvedValue(false);
  predicates.access.mockReset().mockResolvedValue(false);
  store.workspaces = { "ws-a": "org-1", "ws-b": "org-1" };
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

  it("an unknown workspace id is a 404 before any predicate runs", async () => {
    await expect(
      requireWorkspaceManagement(ctx("session"), "ws-missing"),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(predicates.manage).not.toHaveBeenCalled();
    expect(predicates.access).not.toHaveBeenCalled();
  });

  describe("the caller's-org fence (api-ee-behaviour §2.2)", () => {
    it("404s a workspace that belongs to a DIFFERENT org than the caller's scoped org, even for a real manager of that org", async () => {
      // The workspace really is in org-2, and the caller really can manage
      // workspaces there (predicates would say yes) - but the caller is
      // scoped to org-1 (an org key's own org, or a session's
      // x-organization-id), so this must 404 before manage/access ever run.
      store.workspaces["ws-a"] = "org-2";
      predicates.manage.mockResolvedValue(true);
      await expect(
        requireWorkspaceManagement(ctx("session", undefined, "org-1"), "ws-a"),
      ).rejects.toMatchObject({
        code: "NOT_FOUND",
        message: "Workspace not found",
      });
      expect(predicates.manage).not.toHaveBeenCalled();
      expect(predicates.access).not.toHaveBeenCalled();
    });

    it("passes when the caller's scoped org matches the workspace's real org", async () => {
      store.workspaces["ws-a"] = "org-2";
      predicates.manage.mockResolvedValue(true);
      await expect(
        requireWorkspaceManagement(ctx("session", undefined, "org-2"), "ws-a"),
      ).resolves.toBeUndefined();
    });
  });
});
