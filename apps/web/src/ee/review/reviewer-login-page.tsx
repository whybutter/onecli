import { notFound } from "next/navigation";

/**
 * The app-store-reviewer login backdoor is a cloud-ops surface with no
 * onprem equivalent — a plain 404, same convention as `billing-route.tsx`
 * for every permanently dropped surface.
 */
export default function ReviewerLoginPage() {
  notFound();
}
