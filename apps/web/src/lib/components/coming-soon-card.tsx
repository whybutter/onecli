import { Clock } from "lucide-react";

export interface ComingSoonCardProps {
  /** The page/section title, e.g. "Groups". */
  title: string;
  /** One or two sentences on what the surface will do once it ships. */
  description: string;
}

/**
 * The full-surface placeholder state for a v2-migration Phase 0 stand-in
 * page. Rendered INSTEAD of the real page (the decided posture: these
 * surfaces build out in a later phase, so they fetch nothing yet).
 * Server-component-safe: no hooks, no client APIs.
 *
 * Replaces the old fork's `EnterpriseLockedCard` — there is no license dial
 * left to gate on (`isEntitled()` is always true), so nothing in the UI
 * should say "Enterprise" anymore.
 */
export const ComingSoonCard = ({ title, description }: ComingSoonCardProps) => (
  <div className="flex min-h-[50svh] items-center justify-center">
    <div className="flex max-w-sm flex-col items-center text-center">
      <div className="bg-card flex size-14 items-center justify-center rounded-2xl border shadow-sm">
        <Clock aria-hidden="true" className="text-muted-foreground size-6" />
      </div>
      <h2 className="mt-4 text-base font-semibold">{title}</h2>
      <p className="text-muted-foreground mt-3 text-sm">{description}</p>
    </div>
  </div>
);
