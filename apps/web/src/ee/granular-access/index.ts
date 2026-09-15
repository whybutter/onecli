import { githubAppConfig } from "@/lib/granular-access/configs/github-app";
import { dropboxConfig } from "@/lib/granular-access/configs/dropbox";
import type { GranularAccessConfig } from "@/lib/granular-access/types";

export type {
  GranularAccessConfig,
  GranularAccessItem,
  PolicyDialogContentProps,
} from "@/lib/granular-access/types";

/**
 * Real map (not a stand-in): the connection rows and the policy editor's
 * summary text need it to describe a connection's resource scope even
 * before the picker UI ships. `PolicyDialogContent` is intentionally
 * omitted from both configs for now — the pickers (GitHub repo browser,
 * Dropbox folder browser) are Phase 3 work, so `ResourceScopeFields`
 * (`ee/policy-editor/_components/resource-scope-fields.tsx`) renders its
 * "coming later" placeholder instead of opening a manage dialog.
 */
export const granularAccessConfigs: Map<string, GranularAccessConfig> = new Map(
  [
    ["github-app", githubAppConfig],
    ["dropbox", dropboxConfig],
  ],
);
