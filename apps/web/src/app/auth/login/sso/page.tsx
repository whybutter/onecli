import { redirect } from "next/navigation";

/**
 * SSO is permanently dropped in this build (v2 migration plan: no SSO/SCIM;
 * Google login + email/password cover it). Redirects unconditionally rather
 * than rendering the (null) `SsoLoginContent` stand-in, so a stray visit or
 * bookmark lands somewhere useful instead of a blank page. Documented
 * free-file deviation from the plain "remove the dead entitlement branch"
 * pattern used by the other route wrappers, since this route's other arm
 * was always a redirect, never `EnterpriseLockedCard`.
 */
export default function Page() {
  redirect("/auth/login");
}
