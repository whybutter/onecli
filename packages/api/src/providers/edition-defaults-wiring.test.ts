import { afterAll, describe, expect, it, vi } from "vitest";
import type { PublishedEvent } from "../services/event-bus";

/**
 * What `ensureEditionDefaults()` wires into each provider slot, on the REAL
 * seams (not the slot factory, which has its own unit tests): the entitlement
 * choke points (rule-action gate, SSO enforcer, workspace-access checker,
 * event bus), the attachment blob store, and the secret-crypto backend.
 *
 * Each case names an env tuple. `edition-defaults` pulls in a very large
 * module graph, so one module generation is loaded per distinct tuple and
 * reused: these cases only compare object identity after boot wiring, which
 * a shared generation keeps valid. Cases that mutate a slot restore it in a
 * `finally`, and the one that flips the entitlement takes a fresh generation.
 */

type Env = {
  edition: "cloud" | "onprem";
  bucket?: string;
  key?: string;
  /** Run `ensureEditionDefaults()` after the import (the booted process). */
  ensure?: boolean;
};

const ENV_NAMES = [
  "EDITION",
  "NEXT_PUBLIC_EDITION",
  "ATTACHMENTS_S3_BUCKET",
  "SECRET_ENCRYPTION_KEY",
] as const;

const SAVED = Object.fromEntries(
  ENV_NAMES.map((name) => [name, process.env[name]]),
);

const applyEnv = (env: Env) => {
  process.env.EDITION = env.edition === "cloud" ? "cloud" : "";
  process.env.NEXT_PUBLIC_EDITION = process.env.EDITION;
  process.env.ATTACHMENTS_S3_BUCKET = env.bucket ?? "";
  process.env.SECRET_ENCRYPTION_KEY = env.key ?? "";
};

const importGeneration = async (env: Env) => {
  vi.resetModules();
  applyEnv(env);
  // One module generation for everything, so identity comparisons are valid.
  const generation = {
    providers: await import("./index"),
    attachmentStore: await import("./attachment-store"),
    crypto: await import("./crypto"),
    defaults: await import("../edition-defaults"),
    eeGate: await import("../ee/hooks/rule-action-gate"),
    eeSso: await import("../ee/sso/sso-enforcement"),
    authz: await import("../ee/services/authorization-service"),
    pg: await import("../services/attachments/pg-blob-store"),
    kms: await import("../ee/kms-crypto"),
    local: await import("../lib/crypto"),
    agentDesktop: await import("./hooks/agent-desktop"),
  };
  if (env.ensure) generation.defaults.ensureEditionDefaults();
  return generation;
};

type Generation = Awaited<ReturnType<typeof importGeneration>>;
const generations = new Map<string, Promise<Generation>>();

/** The memoized generation for this env tuple (env re-applied every call,
 * since some reads, e.g. the entitlement, happen at call time). */
const loadWith = (env: Env): Promise<Generation> => {
  const key = JSON.stringify([
    env.edition,
    env.bucket ?? "",
    env.key ?? "",
    env.ensure ?? false,
  ]);
  let generation = generations.get(key);
  if (!generation) {
    generation = importGeneration(env);
    generations.set(key, generation);
  }
  applyEnv(env);
  return generation;
};

afterAll(() => {
  for (const name of ENV_NAMES) {
    const value = SAVED[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  vi.resetModules();
});

const KEY = Buffer.alloc(32, 7).toString("base64");

// The entitlement choke points: one call site (`getRuleActionGate()` /
// `getSessionEnforcer()`) resolves to the PLAN-based cloud implementation
// after `ensureEditionDefaults()`, to the permissive onprem default with zero
// setup, and fails loudly on cloud when the boot wiring was skipped. The
// entitlement flag slots into exactly this resolution: the onprem arm swaps
// from "allow all" to "ask the feature flags", and no call site changes.
describe("edition resolution at the real seams", () => {
  it("onprem: permissive defaults with zero setup — the gate allows, SSO never enforces", async () => {
    const { providers } = await loadWith({ edition: "onprem" });
    // No init, no ensureEditionDefaults — the self-hosted process shape.
    await expect(
      providers
        .getRuleActionGate()
        .assertAllowed({ organizationId: "org-1" }, ["manual_approval"]),
    ).resolves.toBeUndefined();
    expect(providers.getSessionEnforcer()).toBeNull();
    // No checker either: the flat team's shared predicates short-circuit on
    // !CAPS.rbac and never consult the slot.
    expect(providers.getWorkspaceAccessChecker()).toBeNull();
  });

  it("cloud: a read before ensureEditionDefaults() is a loud wiring error, never a silent onprem fallback", async () => {
    const { providers } = await loadWith({ edition: "cloud" });
    expect(() => providers.getRuleActionGate()).toThrow(
      /ruleActionGate.*ensureEditionDefaults/s,
    );
    expect(() => providers.getEventBus()).toThrow(
      /event-bus.*ensureEditionDefaults/s,
    );
  });

  it("cloud: after ensureEditionDefaults(), call sites get the real plan-gated implementations", async () => {
    const { providers, eeGate, eeSso } = await loadWith({
      edition: "cloud",
      ensure: true,
    });
    expect(providers.getRuleActionGate()).toBe(eeGate.eeRuleActionGate);
    expect(providers.getSessionEnforcer()).toBe(eeSso.enforceSsoSession);
  });

  // The workspace-access checker's boot wiring, pinned in both arms: deleting
  // either `setDefaultWorkspaceAccessChecker`/`initWorkspaceAccessChecker`
  // line in edition-defaults.ts reproduces the silent-deny outage the seam's
  // comments memorialize (entitled owner bounced off every workspace) — so
  // the wiring itself must be under test, not just the seam's arms.
  it("cloud: the workspace-access checker resolves to the licensed implementation", async () => {
    const { providers, authz } = await loadWith({
      edition: "cloud",
      ensure: true,
    });
    expect(providers.getWorkspaceAccessChecker()).toBe(
      authz.eeWorkspaceAccessChecker,
    );
  });

  // The event-bus boot wiring, pinned the same way: the Redis bus's own suite
  // covers the implementation and event-bus.test.ts covers the onprem seam,
  // but nothing else asserts the cloud arm actually ARMS the slot — deleting
  // the `setDefaultEventBus` call in edition-defaults.ts would pass every
  // suite and 500 the first live transcript (the slot is fail-loud on cloud).
  it("cloud: the event bus is wired at boot — a publish reaches a live subscriber", async () => {
    const { providers } = await loadWith({ edition: "cloud", ensure: true });
    const bus = providers.getEventBus();
    // One instance across gets, or subscribe and publish split brains.
    expect(providers.getEventBus()).toBe(bus);

    const published: PublishedEvent = {
      seq: 1,
      turnId: "t-1",
      type: "text.delta",
      event: { type: "text.delta", text: "chunk-1" },
    };
    const seen: PublishedEvent[][] = [];
    const subscription = bus.subscribe("cv-1", (events) => seen.push(events));
    await subscription.ready;
    bus.publish("cv-1", [published]);
    expect(seen).toEqual([[published]]);
    subscription.release();
  });

  it("self-host: the workspace-access checker rides the override arm", async () => {
    const { providers, authz } = await loadWith({
      edition: "onprem",
      ensure: true,
    });
    expect(providers.getWorkspaceAccessChecker()).toBe(
      authz.eeWorkspaceAccessChecker,
    );
  });

  it.each(["cloud", "onprem"] as const)(
    "%s: boots with the desktop provider disabled",
    async (edition) => {
      const { agentDesktop } = await loadWith({ edition, ensure: true });
      expect(agentDesktop.getAgentDesktop()).toBeNull();
    },
  );

  it("tests/hosts can still override, and null-reset returns to the edition default", async () => {
    const { providers, eeGate } = await loadWith({
      edition: "cloud",
      ensure: true,
    });
    const fake = { assertAllowed: vi.fn(async () => {}) };
    try {
      providers.initRuleActionGate(fake);
      expect(providers.getRuleActionGate()).toBe(fake);
    } finally {
      providers.initRuleActionGate(null);
    }
    expect(providers.getRuleActionGate()).toBe(eeGate.eeRuleActionGate);
  });
});

describe("attachment blob store selection", () => {
  it.each(["cloud", "onprem"] as const)(
    "%s: stores attachment bytes in Postgres",
    async (edition) => {
      const { attachmentStore, pg } = await loadWith({
        edition,
        bucket: "unused-bucket",
        ensure: true,
      });
      expect(attachmentStore.getAttachmentStore()).toBe(
        pg.pgAttachmentBlobStore,
      );
    },
  );
});

/**
 * Which secret-crypto backend is installed. The rule must match the gateway's
 * `wiring::create_crypto_service` exactly: an explicit SECRET_ENCRYPTION_KEY
 * selects local AES, otherwise (cloud) KMS envelope. The gateway decrypts
 * only the format its own backend writes, so when the two disagree every
 * credential the API saves (an OAuth reconnect, a refreshed token) is
 * unreadable at injection time — the request goes out with no credential and
 * the agent sees "access revoked".
 */
describe("secret crypto selection (parity with the gateway)", () => {
  const cryptoFor = async (env: {
    edition: "cloud" | "onprem";
    key: string;
  }) => {
    const generation = await loadWith({ ...env, ensure: true });
    return {
      crypto: generation.crypto.getCrypto(),
      kms: generation.kms,
      local: generation.local,
    };
  };

  it("cloud without SECRET_ENCRYPTION_KEY → KMS envelope", async () => {
    const { crypto, kms } = await cryptoFor({ edition: "cloud", key: "" });
    expect(crypto).toBe(kms.cryptoService);
  });

  it("cloud WITH SECRET_ENCRYPTION_KEY → local AES, like the gateway", async () => {
    const { crypto, local } = await cryptoFor({ edition: "cloud", key: KEY });
    expect(crypto).toBe(local.cryptoService);
    // The 3-part format is the one the gateway's local backend decrypts.
    expect((await crypto.encrypt("x")).split(":")).toHaveLength(3);
  });

  it("onprem → local AES", async () => {
    const { crypto, local } = await cryptoFor({ edition: "onprem", key: KEY });
    expect(crypto).toBe(local.cryptoService);
  });
});
