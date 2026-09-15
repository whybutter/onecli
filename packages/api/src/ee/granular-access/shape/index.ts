import { ServiceError } from "../../../services/errors";

const MAX_DROPBOX_FOLDERS = 100;
const MAX_DROPBOX_PATH_LEN = 1024;

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((v) => typeof v === "string");

const validateGithubAppShape = (
  metadata: Record<string, unknown> | null,
  policy: Record<string, unknown>,
) => {
  const repositories = policy.repositories;
  if (repositories === undefined || repositories === null) return;
  if (!isStringArray(repositories)) {
    throw new ServiceError("BAD_REQUEST", "repositories must be an array");
  }
  if (repositories.length === 0) return;

  const available = new Set(
    isStringArray(metadata?.repos) ? metadata.repos : [],
  );
  const missing = repositories.filter((repo) => !available.has(repo));
  if (missing.length > 0) {
    throw new ServiceError(
      "BAD_REQUEST",
      `Repositories not available on this installation: ${missing.join(", ")}`,
    );
  }
};

const validateDropboxShape = (policy: Record<string, unknown>) => {
  const folders = policy.folders;
  if (folders === undefined || folders === null) return;
  if (!Array.isArray(folders)) {
    throw new ServiceError("BAD_REQUEST", "folders must be an array");
  }
  if (folders.length === 0) return;
  if (folders.length > MAX_DROPBOX_FOLDERS) {
    throw new ServiceError(
      "BAD_REQUEST",
      `Too many folders selected (max ${MAX_DROPBOX_FOLDERS})`,
    );
  }
  for (const folder of folders) {
    if (
      typeof folder !== "string" ||
      !folder.startsWith("/") ||
      folder.length > MAX_DROPBOX_PATH_LEN
    ) {
      throw new ServiceError(
        "BAD_REQUEST",
        `Invalid folder path: ${String(folder)}`,
      );
    }
  }
};

/**
 * Write-time validation of a grant's session policy against its provider:
 *
 * - `github-app`: `{ repositories: string[] }` — absent/empty is accepted;
 *   otherwise every entry must be a repository the installation exposes
 *   (`metadata.repos`).
 * - `dropbox`: `{ folders: string[] }` — absent/empty is accepted; at most
 *   100 entries, each an absolute path of at most 1024 characters.
 * - any other provider: accepted as-is (no granular configuration exists).
 *
 * Deliberately db-free: the caller passes the connection's metadata.
 */
export const validatePolicyShape = async (
  provider: string,
  metadata: Record<string, unknown> | null,
  policy: Record<string, unknown>,
): Promise<void> => {
  switch (provider) {
    case "github-app":
      validateGithubAppShape(metadata, policy);
      return;
    case "dropbox":
      validateDropboxShape(policy);
      return;
    default:
      return;
  }
};
