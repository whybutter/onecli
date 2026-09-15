// Re-exported for compatibility: the type itself now lives in free code
// (`lib/policy-editor/resource-scope-types.ts`) so a future replacement of
// this ee module never has to touch `resource-scope.tsx`'s import.
export type { ResourceScopeFieldsProps } from "@/lib/policy-editor/resource-scope-types";

import type { ResourceScopeFieldsProps } from "@/lib/policy-editor/resource-scope-types";

/**
 * The real per-resource picker (GitHub repositories / Dropbox folders) is
 * Phase 3 work — this dynamic import is only ever reached when `IS_CLOUD`,
 * which is permanently false in this onprem-only fork, so
 * `lib/policy-editor/resource-scope.tsx` renders its own onprem hint
 * instead. Kept as a plain text placeholder rather than `null` so a stray
 * direct import (a test, a future Phase 3 draft) shows something sane.
 */
export const ResourceScopeFields = ({}: ResourceScopeFieldsProps) => (
  <p className="text-muted-foreground rounded-md border border-dashed px-3 py-2 text-xs">
    Resource scoping is available in a later phase.
  </p>
);
