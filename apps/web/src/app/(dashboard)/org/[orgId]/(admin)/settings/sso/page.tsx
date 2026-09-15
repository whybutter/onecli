import { redirect } from "next/navigation";

/**
 * SSO is permanently dropped in this build (v2 migration plan: no SSO/SCIM;
 * Google login + email/password cover it). Redirects to the settings page
 * that does exist rather than rendering a placeholder for a feature with no
 * place on the roadmap — same convention as `/claim` and `/review/login`.
 */
export default async function Page({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;
  redirect(`/org/${orgId}/settings/general`);
}
