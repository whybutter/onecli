import { ComingSoonCard } from "@/lib/components/coming-soon-card";

/**
 * The app-store-reviewer login backdoor is a cloud-ops surface with no
 * onprem equivalent — placeholder rather than a 404 so a stray bookmark
 * gets an explanation instead of a dead end.
 */
export default function ReviewerLoginPage() {
  return (
    <ComingSoonCard
      title="Reviewer login"
      description="This login is not part of this build."
    />
  );
}
