import { notFound } from "next/navigation";

/**
 * Billing (Stripe checkout/portal, plan switching) is permanently dropped in
 * this build — there is no plan to bill for. A plain 404 rather than a
 * placeholder page: unlike the KEEP-but-deferred surfaces (Groups, Domains,
 * ...), billing has no "later phase" to point to.
 */
export default function BillingRoute() {
  notFound();
}
