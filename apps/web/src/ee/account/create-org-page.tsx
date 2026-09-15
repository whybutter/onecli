import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getServerSession } from "@/lib/auth/server";
import { CreateOrgForm } from "./_components/create-org-form";

export const metadata: Metadata = { title: "Create a new organization" };

/** "{name}'s Org", falling back to the email's local part. */
const suggestedOrgName = (name: string | undefined, email: string) => {
  const base = name?.trim() || email.split("@")[0] || "My";
  return `${base}'s Org`;
};

/**
 * Create a new organization. No cap and no plan check — multi-org is uncapped
 * in this edition — so a signed-in user always gets the form.
 */
export default async function CreateOrgPage() {
  const session = await getServerSession();
  if (!session) redirect("/auth/login");

  return (
    <CreateOrgForm
      defaultName={suggestedOrgName(session.name, session.email)}
    />
  );
}
