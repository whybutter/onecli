import type { HostedAvailability } from "./availability";
import { showsHostedSurface } from "./availability";

/**
 * ONE create door, not two buttons (amends §3.15's "two doors, never a
 * picker" — which shipped as literally two primary buttons competing for the
 * same corner).
 *
 * On CLOUD the door is chosen by the org's creation world — the manually
 * operated `Organization.byoLegacy` column (sandbox-platform §3.10 as
 * re-decided 2026-08-23), served by GET /v1/org:
 *
 * - `false` (every org by default): hosted-only. One button, straight into
 *   hosted creation, whatever agents the workspace already holds — the server
 *   refuses BYO creation for these orgs anyway. With `byoEnabled` set (the
 *   mixed world, 2026-08-29) the hosted button stays primary and a chevron
 *   offers BYO creation — the server allows both kinds there.
 * - `true` (set by an operator): the BYO world — exactly the legacy
 *   experience below, whatever agents the workspace holds (`byoEnabled` is
 *   never consulted).
 *
 * On SELF-HOST (and while the org read is unresolved) BYO is ALWAYS primary
 * (Nanoclaw/BYO-first — a self-host-only decision; the cloud arms above are
 * unaffected). Agent history plays no part: whether the workspace is
 * brand-new, already runs BYO agents, or holds only hosted ones, the button
 * is BYO. A hosted surface — a runner registered and reachable — adds
 * hosted as a SECONDARY door in the chevron, never the primary button:
 *
 * - No hosted surface (`absent`, or still `loading` — never flash the wrong
 *   door) → BYO alone.
 * - A hosted surface exists (`ready` or `offline` — offline is a runtime
 *   state, not "the surface doesn't exist") → BYO primary, hosted one click
 *   away in the chevron.
 */
export type CreateDoor =
  /** Hosted only: one button, straight into hosted creation. */
  | "hosted"
  /** BYO only: one button, exactly today's flow. No hosted surface here. */
  | "byo"
  /** Split: BYO primary + a chevron whose menu offers hosted. */
  | "byo-with-hosted"
  /** Split, the MIXED world (cloud, byoLegacy=false + byoEnabled=true):
   *  hosted primary + a chevron whose menu offers BYO creation directly —
   *  the gradual-migration door. */
  | "hosted-with-byo";

export interface CreateDoorInput {
  /** The workspace's agents. `undefined` while the list is still loading.
   *  `kind` is typed loosely because the server action widens it to `string`;
   *  an unrecognized kind simply isn't legacy, which is the safe read. */
  agents: { kind: string }[] | undefined;
  availability: HostedAvailability;
  /** The org's creation world on cloud — `Organization.byoLegacy` from
   *  GET /v1/org. `null` = self-host, or the read failed: fall back to the
   *  workspace-derived rule. Callers should hold the page on the read's
   *  `isPending` instead of passing a transient null (the world decides the
   *  PRIMARY button, and swapping a primary after paint breaks the user). */
  orgByoLegacy: boolean | null;
  /** The mixed-world column beside it — `Organization.byoEnabled` from the
   *  same read (2026-08-29). Only consulted when `orgByoLegacy` is false:
   *  true re-opens BYO creation beside the hosted default. `null` follows
   *  `orgByoLegacy` (self-host / failed read). */
  orgByoEnabled: boolean | null;
}

export const createDoor = ({
  availability,
  orgByoLegacy,
  orgByoEnabled,
}: CreateDoorInput): CreateDoor => {
  const hostedPossible = showsHostedSurface(availability);
  // The org's world is authoritative on cloud — the workspace's agents don't
  // get a vote (a BYO-world org's fresh workspace still gets the BYO door;
  // a hosted-world org keeps the hosted door even beside old BYO agents,
  // which stay fully functional — only creation is world-gated).
  if (orgByoLegacy === true) return hostedPossible ? "byo-with-hosted" : "byo";
  // The mixed world (byoLegacy=false + byoEnabled=true, 2026-08-29): hosted
  // stays the primary, BYO creation lives one click away in the chevron.
  // Availability doesn't gate the chevron — BYO needs no runner, and the
  // hosted-world door already ignores availability on cloud.
  if (orgByoLegacy === false)
    return orgByoEnabled === true ? "hosted-with-byo" : "hosted";
  // Self-host (or a failed cloud org read, which collapses to the same
  // `null` world): BYO-first — hosted is never primary here, whatever the
  // workspace's agent history is. The only input that matters is whether a
  // hosted surface exists at all.
  return hostedPossible ? "byo-with-hosted" : "byo";
};

/**
 * The 15-minute onboarding call (cal.com). A legacy user's move to hosted
 * agents is a migration, not a form submission: their BYO setup, their keys
 * and their scripts all have to land somewhere. So the chevron's hosted entry
 * books a human rather than opening the create dialog — deliberately, until
 * self-serve migration exists.
 */
export const ONBOARDING_CALL_URL = "https://cal.com/onecli/15min";
