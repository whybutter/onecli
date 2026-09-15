import type { WorkspaceAccessChecker } from "./types";
import { createEditionSlot } from "./edition-state";

// Edition default: cloud answers the workspace-access and org-admin
// questions from the ee authorization service via `setDefaultWorkspaceAccessChecker`
// — keeping that service (and its DB client) out of client bundles; onprem
// injects the same `eeWorkspaceAccessChecker` via `initWorkspaceAccessChecker`
// in `ensureEditionDefaults()` (RBAC is enforced in every edition of this
// build; see CLAUDE.md). A missing checker is a host wiring bug and denies
// loudly at the call site (`services/workspace-access-check.ts`), mirroring
// the role-resolver slot.
const slot = createEditionSlot<WorkspaceAccessChecker | null>(
  "workspaceAccessChecker",
  null,
);

export const initWorkspaceAccessChecker = (c: WorkspaceAccessChecker | null) =>
  slot.init(c);

/** Package-internal: the edition-defaults injector. Not exported from the barrel. */
export const setDefaultWorkspaceAccessChecker = (c: WorkspaceAccessChecker) =>
  slot.setCloudDefault(c);

export const getWorkspaceAccessChecker = (): WorkspaceAccessChecker | null =>
  slot.get();
