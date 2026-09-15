import { redirect } from "next/navigation";

/**
 * Provisioning/claim links are permanently dropped (this fork uses
 * invitations + Google login instead — see the v2 migration plan).
 * Redirects home rather than rendering a placeholder for a feature with no
 * place on the roadmap — same convention as `/org/:id/settings/sso` and
 * `/review/login`.
 */
export default function Page() {
  redirect("/");
}
