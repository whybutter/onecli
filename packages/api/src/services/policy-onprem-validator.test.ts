import { describe, expect, it, vi } from "vitest";
import { onpremPolicyValidator } from "./policy-onprem-validator";
import { validatePolicyShape } from "../ee/granular-access/shape";
import { eePolicyValidator } from "../ee/granular-access";
import { getPolicyValidator } from "../providers";

// The provider slot resolves its uninjected default from the edition at import.
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "onprem";
});

// Both editions validate policy shape without looking up the organization's
// plan. The gateway enforces the granular scopes saved by the validator.

describe("onpremPolicyValidator.validate (shape-only, no plan gate)", () => {
  it("accepts a provider without a granular config (no lock)", async () => {
    await expect(
      onpremPolicyValidator.validate("org-1", "github", null, {
        repositories: ["a/b"],
      }),
    ).resolves.toBeUndefined();
  });

  it("accepts github-app repositories present on the installation", async () => {
    await expect(
      onpremPolicyValidator.validate(
        "org-1",
        "github-app",
        { repos: ["acme/api", "acme/web"] },
        { repositories: ["acme/api"] },
      ),
    ).resolves.toBeUndefined();
  });

  it("rejects github-app repositories missing from the installation (the shared shape rule)", async () => {
    await expect(
      onpremPolicyValidator.validate(
        "org-1",
        "github-app",
        { repos: ["acme/api"] },
        { repositories: ["acme/other"] },
      ),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("acme/other"),
    });
  });

  it("accepts absolute dropbox folder paths and rejects relative ones", async () => {
    await expect(
      onpremPolicyValidator.validate("org-1", "dropbox", null, {
        folders: ["/Work/Reports"],
      }),
    ).resolves.toBeUndefined();
    await expect(
      onpremPolicyValidator.validate("org-1", "dropbox", null, {
        folders: ["not-absolute"],
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("rejects Drive folder scopes when the gateway cannot enforce them", async () => {
    await expect(
      onpremPolicyValidator.validate("org-1", "google-drive", null, {
        driveFolders: ["0ASharedDrive/1folder"],
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      onpremPolicyValidator.validate("org-1", "google-drive", null, {
        driveFolders: ["/My Drive/Reports"],
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    // Another provider's axis would be unenforceable — refused for each one.
    await expect(
      onpremPolicyValidator.validate("org-1", "google-drive", null, {
        folders: ["/Work"],
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      onpremPolicyValidator.validate("org-1", "dropbox", null, {
        driveFolders: ["0ASharedDrive"],
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("is exactly the shared shape half (parity with the cloud validator)", async () => {
    const metadata = { repos: ["acme/api"] };
    const policy = { repositories: ["acme/ghost"] };
    const viaOnprem = await onpremPolicyValidator
      .validate("org-1", "github-app", metadata, policy)
      .catch((e: unknown) => e);
    const viaShape = await validatePolicyShape(
      "github-app",
      metadata,
      policy,
    ).catch((e: unknown) => e);
    expect(viaOnprem).toBeInstanceOf(Error);
    expect((viaOnprem as Error).message).toBe((viaShape as Error).message);
  });
});

describe("the edition validators", () => {
  it("the ee validator IS the onprem validator — one shape check, no plan or licence gate", () => {
    expect(eePolicyValidator).toBe(onpremPolicyValidator);
  });

  it("the uninjected onprem default is the shape check with no entitlement in front", async () => {
    // Before the v2 migration the onprem default asserted the granular_access
    // entitlement first; this build is always entitled, so the default is the
    // bare validator and an unrestricted shape passes with zero setup.
    await expect(
      getPolicyValidator().validate("org-1", "dropbox", null, {
        folders: ["/Work"],
      }),
    ).resolves.toBeUndefined();
  });
});

describe("onpremPolicyValidator.validateTargets", () => {
  it("is absent — all providers are allowed (the one-catalog gateway enforces them)", () => {
    // Absent = permissive per the PolicyValidator contract; a cloud-only
    // provider in an app target is no longer rejected on onprem.
    expect(onpremPolicyValidator.validateTargets).toBeUndefined();
  });
});
