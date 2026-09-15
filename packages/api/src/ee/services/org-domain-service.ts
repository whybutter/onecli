import { randomBytes } from "node:crypto";
import { resolveTxt } from "node:dns/promises";
import { domainToASCII } from "node:url";
import { db } from "@onecli/db";
import { ServiceError } from "../../services/errors";
import { isUniqueViolation } from "../lib/prisma-errors";

/**
 * The organization's claimed email domains — api-ee-behaviour §8.1, ported
 * verbatim (this fork ships domains). `OrganizationDomain.verifiedAt` is the
 * whole state machine: null = claimed-but-pending, non-null = verified.
 * There is deliberately no "failed" state — a DNS miss throws and leaves the
 * row untouched, since a miss now may be a hit thirty seconds from now.
 *
 * Every read/write is scoped to ONE organization, `findFirst`/`updateMany`/
 * `deleteMany({ id, organizationId })`, so a cross-org id reads as absent
 * (404) — except uniqueness, which is GLOBAL: `OrganizationDomain.domain` is
 * `@unique` across every org, verified or not, because a domain is a single
 * claim on a namespace no two tenants can share.
 */

/** The wire shape (matches the client's `OrgDomain`). */
export interface OrgDomainRow {
  id: string;
  domain: string;
  verificationToken: string;
  verifiedAt: string | null;
  createdAt: string;
}

interface DomainRecord {
  id: string;
  domain: string;
  verificationToken: string;
  verifiedAt: Date | null;
  createdAt: Date;
}

const SELECT = {
  id: true,
  domain: true,
  verificationToken: true,
  verifiedAt: true,
  createdAt: true,
} as const;

const toRow = (row: DomainRecord): OrgDomainRow => ({
  id: row.id,
  domain: row.domain,
  verificationToken: row.verificationToken,
  verifiedAt: row.verifiedAt?.toISOString() ?? null,
  createdAt: row.createdAt.toISOString(),
});

// ─── Normalization ──────────────────────────────────────────────────────────

/** `([a-z0-9-]+.)+[a-z0-9-]{2,}` — labels plus a 2+ char TLD; no bare label. */
const DOMAIN_RE = /^([a-z0-9-]+\.)+[a-z0-9-]{2,}$/;

/**
 * Trim, lowercase, strip one trailing DNS-root dot, IDNA/punycode to ASCII
 * (`münchen.de` → `xn--mnchen-3ya.de`), then shape-check. `null` when the
 * value is not a domain at all (a URL, an email, an IP, a bare label).
 */
const normalizeDomain = (raw: string): string | null => {
  let value = raw.trim().toLowerCase();
  if (value.endsWith(".")) value = value.slice(0, -1);
  if (!value) return null;

  const ascii = domainToASCII(value);
  if (!ascii) return null;
  if (!DOMAIN_RE.test(ascii)) return null;
  return ascii;
};

/**
 * Public mailbox providers can never be claimed — an org "claiming"
 * gmail.com would let it steer every gmail.com address into its own SSO.
 */
const PUBLIC_MAILBOX_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "yahoo.com",
  "ymail.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "pm.me",
  "gmx.com",
  "gmx.net",
  "mail.com",
  "zoho.com",
  "yandex.com",
  "yandex.ru",
  "fastmail.com",
  "hey.com",
  "tutanota.com",
  "tuta.io",
]);

/** The comparison key SSO trust and enforcement key on: same normalization,
 * applied to the part after the last `@`. `null` when absent/invalid. */
export const emailDomainOf = (email: string): string | null => {
  const at = email.lastIndexOf("@");
  if (at < 0 || at === email.length - 1) return null;
  return normalizeDomain(email.slice(at + 1));
};

// ─── Reads / claim / delete ─────────────────────────────────────────────────

export const listOrgDomains = async (
  organizationId: string,
): Promise<OrgDomainRow[]> => {
  const rows = await db.organizationDomain.findMany({
    where: { organizationId },
    select: SELECT,
    orderBy: { createdAt: "asc" },
  });
  return rows.map(toRow);
};

/**
 * Ceiling on how many domains one organization may hold. Not in
 * api-ee-behaviour §8.1 (the upstream spec has no cap); added as a rate-limit
 * floor on the outbound-DNS fan-out a `verify` click opens (see
 * `verifyOrgDomain`) — an uncapped org could mint unbounded rows and fire a
 * lookup at each. A BAD_REQUEST (400): this is a deployment-shape limit the
 * caller can act on immediately (remove one), not a state conflict with
 * another resource (409's territory in Appendix B).
 */
const MAX_ORG_DOMAINS = 25;

export const claimOrgDomain = async (
  organizationId: string,
  userId: string,
  rawDomain: string,
): Promise<OrgDomainRow> => {
  const domain = normalizeDomain(rawDomain);
  if (!domain) {
    throw new ServiceError(
      "BAD_REQUEST",
      "Enter a valid domain like example.com",
    );
  }
  if (PUBLIC_MAILBOX_DOMAINS.has(domain)) {
    throw new ServiceError(
      "BAD_REQUEST",
      "Public email providers can't be claimed. Use your company's domain.",
    );
  }

  const held = await db.organizationDomain.count({ where: { organizationId } });
  if (held >= MAX_ORG_DOMAINS) {
    throw new ServiceError(
      "BAD_REQUEST",
      `An organization can hold at most ${MAX_ORG_DOMAINS} domains. Remove one before adding another.`,
    );
  }

  try {
    const row = await db.organizationDomain.create({
      // `verifiedAt` is left at its default null: a claim is an assertion,
      // only `verifyOrgDomain` may ever set it.
      data: {
        organizationId,
        domain,
        verificationToken: randomBytes(16).toString("hex"),
        createdByUserId: userId,
      },
      select: SELECT,
    });
    return toRow(row);
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ServiceError(
        "CONFLICT",
        "This domain is already claimed by an organization.",
      );
    }
    throw err;
  }
};

const NO_RECORD_CODES = new Set(["ENOTFOUND", "ENODATA", "SERVFAIL"]);
const NOT_FOUND_MESSAGE =
  "TXT record not found yet. DNS changes can take a few minutes to propagate.";

/**
 * Resolver-side failures rather than "no record yet": the lookup itself
 * didn't complete, so nothing was actually learned about whether the record
 * exists. Reported as a retryable 400, not a 500 — this instance's outbound
 * DNS having a bad moment is not an application bug.
 */
const UNREACHABLE_CODES = new Set(["ETIMEOUT", "ECONNREFUSED", "EREFUSED"]);
const UNREACHABLE_MESSAGE = "DNS lookup failed, try again.";

const dnsErrorCode = (err: unknown): string | undefined =>
  typeof err === "object" && err !== null && "code" in err
    ? String((err as { code: unknown }).code)
    : undefined;

/**
 * `resolveTxt` answers `string[][]`: one inner array per record, split into
 * the 255-octet chunks the wire format demands. A record's real value is its
 * chunks CONCATENATED. Lowercased on both sides since the token is hex and
 * some DNS panels normalize a stored value's case.
 */
const flattenTxt = (records: string[][]): string[] =>
  records.map((chunks) => chunks.join("").trim().toLowerCase());

export interface VerifyOrgDomainResult {
  domain: OrgDomainRow;
  /** `false` on the idempotent already-verified path — nothing happened, so
   * the caller (the route) must not audit a fresh VERIFY event for it. */
  changed: boolean;
}

/**
 * Run the DNS check. Already-verified rows return immediately without a DNS
 * call (idempotent — a double-click or a polling client costs nothing extra
 * — and `changed: false` so the caller knows not to audit a non-event).
 * `ENOTFOUND`/`ENODATA`/`SERVFAIL` are "not published yet"; `ETIMEOUT`/
 * `ECONNREFUSED`/`EREFUSED` mean the lookup itself didn't complete (a
 * retryable 400); anything else propagates (an unrecognised resolver fault
 * is not safely reportable as either).
 */
export const verifyOrgDomain = async (
  organizationId: string,
  domainId: string,
): Promise<VerifyOrgDomainResult> => {
  const row = await db.organizationDomain.findFirst({
    where: { id: domainId, organizationId },
    select: SELECT,
  });
  if (!row) throw new ServiceError("NOT_FOUND", "Domain not found");
  if (row.verifiedAt) return { domain: toRow(row), changed: false };

  const expected = `onecli-verification=${row.verificationToken}`.toLowerCase();

  let records: string[][];
  try {
    records = await resolveTxt(row.domain);
  } catch (err) {
    const code = dnsErrorCode(err);
    if (code && NO_RECORD_CODES.has(code)) {
      throw new ServiceError("BAD_REQUEST", NOT_FOUND_MESSAGE);
    }
    if (code && UNREACHABLE_CODES.has(code)) {
      throw new ServiceError("BAD_REQUEST", UNREACHABLE_MESSAGE);
    }
    throw err;
  }

  if (!flattenTxt(records).includes(expected)) {
    throw new ServiceError("BAD_REQUEST", NOT_FOUND_MESSAGE);
  }

  const verifiedAt = new Date();
  // Org-scoped conditional write: a count of 0 means the row was deleted
  // between the read and the write, a 404 rather than a P2025 500.
  const { count } = await db.organizationDomain.updateMany({
    where: { id: domainId, organizationId },
    data: { verifiedAt },
  });
  if (count === 0) throw new ServiceError("NOT_FOUND", "Domain not found");

  return { domain: toRow({ ...row, verifiedAt }), changed: true };
};

/** `DELETE /org/domains/:domainId`. Deliberately never plan-gated (see the
 * route doc): teardown must survive a plan lapse. */
export const deleteOrgDomain = async (
  organizationId: string,
  domainId: string,
): Promise<void> => {
  const { count } = await db.organizationDomain.deleteMany({
    where: { id: domainId, organizationId },
  });
  if (count === 0) throw new ServiceError("NOT_FOUND", "Domain not found");
};
