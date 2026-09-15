import dynamic from "next/dynamic";
import { GitBranch } from "lucide-react";
import type { GranularAccessConfig } from "../types";

// The picker loads on demand: this config sits in the shared chunk (connection
// rows and the policy editor read it for summaries), the picker is only
// needed once someone opens Manage.
const GithubAppPolicyDialogContent = dynamic(
  () =>
    import("../github-app/policy-dialog-content").then(
      (m) => m.GithubAppPolicyDialogContent,
    ),
  { ssr: false },
);

export const githubAppConfig: GranularAccessConfig = {
  // Granular repo scoping applies whenever the connection can be scoped: an
  // installation that grants ALL repositories (`repositorySelection: "all"` —
  // its concrete `repos` list may be empty or not enumerated), or one that
  // already lists specific repos. Both show "All repositories · Manage"
  // (defaulting to unrestricted); only a connection with neither signal is
  // genuinely un-scopable and stays hidden.
  isSupported: (meta) =>
    meta.repositorySelection === "all" ||
    (Array.isArray(meta.repos) && meta.repos.length > 0),
  getItems: (meta) =>
    ((meta.repos as string[]) ?? []).map((repo) => ({
      id: repo,
      label: repo.split("/").pop() ?? repo,
    })),
  buildPolicy: (repos) => (repos.length > 0 ? { repositories: repos } : {}),
  getSelectedItems: (policy) => (policy.repositories as string[]) ?? [],
  itemLabel: { singular: "repository", plural: "repositories" },
  Icon: GitBranch,
  PolicyDialogContent: GithubAppPolicyDialogContent,
};
