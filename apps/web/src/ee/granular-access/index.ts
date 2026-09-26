import { githubAppConfig } from "@/lib/granular-access/configs/github-app";
import { dropboxConfig } from "@/lib/granular-access/configs/dropbox";
import type { GranularAccessConfig } from "@/lib/granular-access/types";

export type {
  GranularAccessConfig,
  GranularAccessItem,
  PolicyDialogContentProps,
} from "@/lib/granular-access/types";

/**
 * The provider map the connection rows and the policy editor read to describe
 * (and edit) a connection's resource scope. GitHub ships its repository
 * picker (`PolicyDialogContent`, loaded on demand from the config); Dropbox
 * keeps the `folders` policy shape for the gateway but has no picker — its
 * folder browser needs a live-browse endpoint this edition does not run — so
 * `ResourceScopeFields` renders nothing for it and the free wrapper shows a
 * plain hint instead.
 */
export const granularAccessConfigs: Map<string, GranularAccessConfig> = new Map(
  [
    ["github-app", githubAppConfig],
    ["dropbox", dropboxConfig],
  ],
);
