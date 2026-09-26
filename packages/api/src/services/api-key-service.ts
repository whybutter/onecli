import { randomBytes } from "crypto";
import { db } from "@onecli/db";
import { logger } from "../lib/logger";
import type { ResourceScope } from "./resource-scope";
import { scopeWhere, scopeCreate, isOrgScope } from "./resource-scope";

/**
 * How often a key's `lastUsedAt` is actually written, in milliseconds.
 *
 * The card this feeds ("Last used 3h ago") renders at that granularity, so a
 * write on every authenticated request would buy nothing observable while
 * costing a write on the hot auth path. MUST move together with the
 * gateway's own throttle constant once the gateway-side stamp lands
 * (phase2-plan risk 8 — deferred to the Phase 1 + Phase 2 integration step;
 * nothing but this comment ties the two values today).
 */
export const API_KEY_LAST_USED_THROTTLE_MS = 15 * 60 * 1000;

/**
 * Record that `apiKey` just authenticated — throttled, and deliberately NOT a
 * write on the per-request path.
 *
 * Two guards, in order:
 *
 * 1. The stored `lastUsedAt` comes back on the row the auth lookup already
 *    read, so the freshness check costs zero extra I/O. Inside the throttle
 *    window this returns immediately having touched nothing — which is the
 *    overwhelming majority of authenticated requests.
 * 2. When the window HAS elapsed, the update repeats the staleness test in its
 *    own `where`. That makes the write idempotent across concurrent requests
 *    and across replicas: a burst that all read the same stale row issues N
 *    statements but only the first matches a row, the rest are no-ops.
 *
 * The `where` also pins the key VALUE, not just the row id. Without it,
 * rotation races the write: `regenerateApiKey` swaps in a new secret and
 * clears `lastUsedAt` on the SAME row, so a request that authenticated with
 * the OLD secret milliseconds earlier could land afterwards, match the
 * `lastUsedAt: null` arm precisely *because* rotation just cleared it, and
 * stamp the new secret as used — showing "Last used just now" on a key nobody
 * has ever held, at the exact moment an operator rotates a leak and checks.
 *
 * Never throws and never reports failure upward — usage telemetry must not be
 * able to turn a request that authenticates today into one that 401s tomorrow.
 * Returns whether a write was attempted (the throttle's observable behaviour).
 */
export const recordApiKeyUse = async (
  apiKey: { id: string; key: string; lastUsedAt: Date | null },
  now: number = Date.now(),
): Promise<boolean> => {
  // Defensive: a caller that forgot to select `id`/`key` must be a silent
  // no-op, not a crash inside authentication.
  if (!apiKey?.id || !apiKey.key) return false;

  const staleBefore = new Date(now - API_KEY_LAST_USED_THROTTLE_MS);
  if (apiKey.lastUsedAt !== null && apiKey.lastUsedAt > staleBefore) {
    return false;
  }

  try {
    await db.apiKey.updateMany({
      where: {
        id: apiKey.id,
        // The secret that actually authenticated — see the rotation race above.
        key: apiKey.key,
        OR: [{ lastUsedAt: null }, { lastUsedAt: { lt: staleBefore } }],
      },
      data: { lastUsedAt: new Date(now) },
    });
  } catch (err) {
    logger.warn(
      { err },
      "Failed to record API key usage; authentication is unaffected.",
    );
  }
  return true;
};

export const generateApiKey = (scope?: ResourceScope) => {
  const prefix = scope && isOrgScope(scope) ? "oc_org_" : "oc_";
  return `${prefix}${randomBytes(32).toString("hex")}`;
};

export const regenerateApiKey = async (
  userId: string,
  scope: ResourceScope,
) => {
  const key = generateApiKey(scope);

  // `kind: "user"` — this helper owns PERSONAL keys only. Without the filter,
  // a platform-minted service key (e.g. a channel presence's approvals key)
  // in the same (user, scope) would make this findFirst nondeterministic, and
  // "regenerate my key" could rotate the service key out from under the
  // machinery holding it — or worse, hand the personal flow a service key.
  const existing = await db.apiKey.findFirst({
    where: { userId, kind: "user", ...scopeWhere(scope) },
    select: { id: true },
  });

  if (existing) {
    await db.apiKey.update({
      where: { id: existing.id },
      // Regenerate mints a NEW secret on the same row, so the old secret's
      // usage history does not describe the new one — carrying `lastUsedAt`
      // over would report a key nobody has ever presented as recently used,
      // which is exactly backwards for the leak it was rotated to fix.
      data: { key, lastUsedAt: null },
    });
  } else {
    const user = await db.user.findUniqueOrThrow({
      where: { id: userId },
      select: { email: true },
    });
    await db.apiKey.create({
      data: { key, userId, userEmail: user.email, ...scopeCreate(scope) },
    });
  }

  return { apiKey: key };
};

/**
 * Return the user's API key for `scope`, creating one if none exists yet.
 * Idempotent — a single call both reads and (lazily) provisions a key for any
 * user authorized for the scope.
 *
 * The dashboard read paths use it so an admin/owner viewing a workspace they did
 * not create still gets *their own* key instead of an empty "no key yet" state —
 * keys are personal (they carry the user's identity for audit/attribution), so
 * we never surface another user's.
 *
 * `created` is `true` only when a key was actually minted, letting callers audit
 * the first provision without logging on every read.
 *
 * `lastUsedAt` rides along so a caller can say whether the key it is about to
 * show is in circulation — a freshly minted key reports `null` here.
 */
export const ensureApiKey = async (
  userId: string,
  scope: ResourceScope,
): Promise<{
  apiKey: string;
  created: boolean;
  lastUsedAt: Date | null;
}> => {
  // Personal keys only — same reasoning as `regenerateApiKey` above.
  const existing = await db.apiKey.findFirst({
    where: { userId, kind: "user", ...scopeWhere(scope) },
    select: { key: true, lastUsedAt: true },
  });
  if (existing)
    return {
      apiKey: existing.key,
      created: false,
      lastUsedAt: existing.lastUsedAt,
    };

  const user = await db.user.findUniqueOrThrow({
    where: { id: userId },
    select: { email: true },
  });
  const key = generateApiKey(scope);
  await db.apiKey.create({
    data: { key, userId, userEmail: user.email, ...scopeCreate(scope) },
  });
  return { apiKey: key, created: true, lastUsedAt: null };
};

/**
 * Mint a SERVICE key: a platform-created machine credential (`kind:
 * "service"`), distinct from a person's own key so the personal flows above
 * never see it. The key still belongs to a real user — the gateway
 * re-validates the owner's live workspace access on every use and stamps
 * `approved_by` from it — so `userId` is the human whose authority the
 * machine borrows (e.g. the member who attached a channel presence).
 *
 * Callers own the row's lifecycle: store the returned id and revoke on
 * teardown (`revokeServiceApiKey`).
 */
export const createServiceApiKey = async (
  userId: string,
  scope: ResourceScope,
  name: string,
): Promise<{ id: string; apiKey: string }> => {
  const user = await db.user.findUniqueOrThrow({
    where: { id: userId },
    select: { email: true },
  });
  const key = generateApiKey(scope);
  const created = await db.apiKey.create({
    data: {
      key,
      userId,
      userEmail: user.email,
      name,
      kind: "service",
      ...scopeCreate(scope),
    },
    select: { id: true },
  });
  return { id: created.id, apiKey: key };
};

/**
 * Delete a service key by id. Deliberately fenced to `kind: "service"` so no
 * teardown path can ever delete a person's own key by mistake; deleting an
 * already-gone key is a no-op (teardown must be idempotent).
 */
export const revokeServiceApiKey = async (id: string): Promise<void> => {
  await db.apiKey.deleteMany({ where: { id, kind: "service" } });
};
